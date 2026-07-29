import "@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { prompt, today } = await req.json();

    const system = `Tu es un parseur intelligent de tâches et de récurrences pour une application de gestion de temps.
Aujourd'hui nous sommes le : ${today}.

Jours de la semaine : 0=Dimanche, 1=Lundi, 2=Mardi, 3=Mercredi, 4=Jeudi, 5=Vendredi, 6=Samedi.

Analyse attentivement la demande de l'utilisateur (en français) et réponds EXCLUSIVEMENT avec un objet JSON structuré comme suit :
{
  "is_recurring": boolean,
  "title": string,
  "category": "chores" | "shopping" | "study",
  "urgent": boolean,
  "due_date": "YYYY-MM-DD" | null,
  "due_time": "HH:MM" | null,
  "recurring_days": number[] | null
}

Règles de parsing :
1. "is_recurring": met à 'true' si l'utilisateur mentionne une fréquence ou habitude (ex: "tous les mardis", "chaque semaine", "tous les jours", "mardi et jeudi").
2. "recurring_days": si récurrent, renvoie le tableau des jours concernés [0..6]. Ex: "mardi et jeudi" -> [2, 4]. "tous les jours" -> [0, 1, 2, 3, 4, 5, 6].
3. Si récurrent, "due_date" doit être 'null'. Sinon, calcule la date exacte YYYY-MM-DD basée sur aujourd'hui (${today}).
4. "category": "chores" = ménage/maison/bricolage, "shopping" = courses/achats, "study" = études/révisions/devoirs/cours.
5. "due_time": format HH:MM (ex: "18:30"). Si non mentionné, renvoie null.
6. "urgent": true si des mots comme "urgent", "rapide", "prioritaire", "🔥" sont utilisés.`;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("GROQ_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      return new Response(JSON.stringify({ error: data }), {
        status: 500, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ result: data.choices[0].message.content }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});