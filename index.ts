import "@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

// ---------- Validation du schéma renvoyé par le LLM ----------
const ACTION_TYPES = new Set([
  "create", "create_recurring", "complete", "uncomplete", "delete",
  "postpone", "update", "set_urgent", "delete_recurring", "none",
]);
const CATEGORIES = new Set(["chores", "shopping", "study"]);

function sanitize(raw: any) {
  const out: { reply: string; actions: any[] } = {
    reply: typeof raw?.reply === "string" ? raw.reply.slice(0, 500) : "C'est fait !",
    actions: [],
  };
  const actions = Array.isArray(raw?.actions) ? raw.actions : [];
  for (const a of actions.slice(0, 10)) {
    if (!a || !ACTION_TYPES.has(a.type)) continue;
    const clean: any = { type: a.type };
    if (typeof a.title === "string" && a.title.trim()) clean.title = a.title.trim().slice(0, 120);
    if (typeof a.target_id === "string") clean.target_id = a.target_id;
    if (typeof a.target_title === "string") clean.target_title = a.target_title.trim().slice(0, 120);
    clean.category = CATEGORIES.has(a.category) ? a.category : "chores";
    clean.urgent = a.urgent === true;
    if (typeof a.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.due_date)) clean.due_date = a.due_date;
    if (typeof a.due_time === "string" && /^\d{2}:\d{2}$/.test(a.due_time)) clean.due_time = a.due_time;
    if (Array.isArray(a.recurring_days)) {
      const days = [...new Set(a.recurring_days.filter((d: any) => Number.isInteger(d) && d >= 0 && d <= 6))];
      if (days.length) clean.recurring_days = days.sort();
    }
    if (a.fields && typeof a.fields === "object") {
      const f: any = {};
      if (typeof a.fields.title === "string" && a.fields.title.trim()) f.title = a.fields.title.trim().slice(0, 120);
      if (CATEGORIES.has(a.fields.category)) f.category = a.fields.category;
      if (typeof a.fields.urgent === "boolean") f.urgent = a.fields.urgent;
      if (typeof a.fields.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.fields.due_date)) f.due_date = a.fields.due_date;
      if (a.fields.due_date === null) f.due_date = null;
      if (typeof a.fields.due_time === "string" && /^\d{2}:\d{2}$/.test(a.fields.due_time)) f.due_time = a.fields.due_time;
      if (a.fields.due_time === null) f.due_time = null;
      if (Object.keys(f).length) clean.fields = f;
    }
    out.actions.push(clean);
  }
  return out;
}

// ---------- Appel Groq avec retry si JSON invalide ----------
async function callGroq(messages: any[]) {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) throw new Error("La clé GROQ_API_KEY est manquante dans les secrets Supabase.");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("Limite de requêtes Groq atteinte (Rate Limit). Réessayez dans un instant.");
    }
    throw new Error(data.error?.message || JSON.stringify(data));
  }
  return data.choices?.[0]?.message?.content ?? "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { prompt, today, tasks = [], recurrences = [], history = [] } = await req.json();
    
    if (typeof prompt !== "string" || !prompt.trim()) {
      return json({ result: { reply: "Désolé, votre demande est vide.", actions: [] } });
    }

    // Contexte compact (plafonné) des tâches existantes
    const taskCtx = (Array.isArray(tasks) ? tasks : []).slice(0, 60)
      .map((t: any) => `- id:${t.id} | "${t.title}" | cat:${t.category} | date:${t.due_date ?? "aucune"} | heure:${t.due_time ?? "-"} | urgent:${!!t.urgent} | fait:${!!t.done}`)
      .join("\n") || "(aucune tâche)";

    const recCtx = (Array.isArray(recurrences) ? recurrences : []).slice(0, 30)
      .map((r: any) => `- id:${r.id} | "${r.title}" | jours:[${(r.recurring_days ?? []).join(",")}] | heure:${r.due_time ?? "-"} | cat:${r.category}`)
      .join("\n") || "(aucune récurrence)";

    const system = `Tu es l'assistant IA de StudySpace, une application de gestion de tâches. Tu réponds en français, tu es concis et sympathique.
Aujourd'hui : ${today}. Jours : 0=Dimanche, 1=Lundi, 2=Mardi, 3=Mercredi, 4=Jeudi, 5=Vendredi, 6=Samedi.
TÂCHES EXISTANTES DE L'UTILISATEUR :
${taskCtx}
RÉCURRENCES ACTIVES :
${recCtx}
Tu réponds EXCLUSIVEMENT avec un objet JSON de la forme :
{
  "reply": "phrase courte de confirmation ou réponse en français",
  "actions": [ { "type": "...", ... } ]
}
Types d'actions disponibles :
1. "create" — nouvelle tâche ponctuelle. Champs : title, category ("chores"|"shopping"|"study"), urgent (bool), due_date ("YYYY-MM-DD" ou null), due_time ("HH:MM" ou null).
2. "create_recurring" — habitude récurrente. Champs : title, category, urgent, recurring_days (tableau [0..6]), due_time (ou null). Jamais de due_date.
3. "complete" / "uncomplete" — cocher/décocher une tâche existante. Champs : target_id (id exact du contexte) OU target_title si l'id est incertain.
4. "delete" — supprimer une tâche existante. Champs : target_id ou target_title.
5. "postpone" — décaler une tâche. Champs : target_id ou target_title, due_date (nouvelle date calculée, ex "demain" = ${today}+1), due_time optionnel.
6. "update" — modifier une tâche. Champs : target_id ou target_title, fields { title?, category?, urgent?, due_date?, due_time? }.
7. "set_urgent" — changer l'urgence. Champs : target_id ou target_title, urgent (bool).
8. "delete_recurring" — supprimer une récurrence. Champs : target_id ou target_title (id d'une RÉCURRENCE).
9. "none" — aucune action (question, salutation, demande d'info). Réponds simplement via "reply". Si on te demande un résumé du planning, construis-le dans "reply" à partir du contexte.
Règles :
- Plusieurs actions possibles dans une seule demande ("ajoute X et supprime Y", "3 tâches : ...") → plusieurs entrées dans "actions", dans l'ordre.
- Pour cibler une tâche, privilégie TOUJOURS target_id en le retrouvant dans le contexte (correspondance approximative sur le titre acceptée). N'invente jamais d'id.
- Si la cible est ambiguë (plusieurs correspondances) ou introuvable, renvoie "actions": [] et pose une question de clarification dans "reply".
- Dates relatives : calcule à partir de ${today}. "demain", "après-demain", "lundi prochain", "dans 3 jours", "ce week-end" (= samedi le plus proche), "fin de semaine" (= vendredi), etc.
- category : ménage/maison/bricolage/rangement = "chores" ; courses/achats = "shopping" ; études/révisions/devoirs/cours/exposés = "study". Par défaut "chores".
- urgent = true si "urgent", "prioritaire", "vite", "important", "🔥", "asap".
- "is_recurring" implicite : "tous les", "chaque", "le lundi" (habitude), "quotidien", "hebdomadaire" → create_recurring. "tous les jours" → [0,1,2,3,4,5,6]. "en semaine" → [1,2,3,4,5]. "le week-end" → [0,6].
- "reply" doit refléter fidèlement ce qui a été fait ("J'ai ajouté... et décalé..."). Jamais de texte hors du JSON.`;

    const messages: any[] = [{ role: "system", content: system }];
    for (const h of (Array.isArray(history) ? history : []).slice(-6)) {
      if (h?.role === "user" || h?.role === "assistant") {
        messages.push({ role: h.role, content: String(h.content).slice(0, 500) });
      }
    }
    messages.push({ role: "user", content: prompt.slice(0, 1000) });

    // 1er essai + retry automatique si le JSON est invalide
    let parsed: any = null;
    let content = await callGroq(messages);
    try {
      parsed = JSON.parse(content);
    } catch {
      content = await callGroq([
        ...messages,
        { role: "assistant", content },
        { role: "user", content: "Ta réponse n'était pas un JSON valide. Renvoie UNIQUEMENT l'objet JSON corrigé, sans aucun autre texte." },
      ]);
      parsed = JSON.parse(content);
    }

    return json({ result: sanitize(parsed) });

  } catch (e: any) {
    // ⚠️ ASTUCE CLÉ : On intercepte l'erreur et renvoie du 200 HTTP 
    // pour éviter l'erreur globale client "non-2xx status code"
    return json({ 
      result: { 
        reply: `⚠️ Une erreur est survenue : ${e.message || "Impossible de contacter l'IA."}`, 
        actions: [] 
      } 
    }, 200);
  }
});
