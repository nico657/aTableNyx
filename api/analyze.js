// Fonction serverless Vercel : /api/analyze
// La clé Gemini reste ici (variable d'environnement GEMINI_API_KEY), jamais dans le navigateur.

// Modèles essayés dans l'ordre (tous stables au moment de l'écriture).
const MODELS = [
  { id: 'gemini-3.8-flash', thinking: true },
  { id: 'gemini-3.6-flash', thinking: true },
  { id: 'gemini-3.5-flash-lite', thinking: false },
];

const TAGS = ['Favori', 'Entrée chaude', 'Entrée froide', 'Accompagnement', 'Salade',
  'Repas principal', 'Ethnique', 'Végé', 'Dessert', 'Boisson'];

const ALLOWED_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/;
const MAX_FILES = 8;
const MAX_TOTAL_CHARS = 4200000; // limite Vercel ≈ 4,5 Mo par requête

const PROMPT = `Analyse le ou les document(s) fourni(s) qui composent une recette de cuisine (pages de livre, fiches manuscrites, fiches imprimées, etc.). Regroupe, déduis et reformate toutes les informations pour créer une fiche uniforme, en français, sans rien inventer : conserve les quantités et les temps d'origine.
Pour chaque ingrédient, écris d'abord la quantité (avec son unité), puis l'ingrédient, par exemple « - 250 g de farine », « - 2 œufs », « - 1 c. à soupe d'huile d'olive ». Si aucune quantité n'est précisée, commence par la mention d'origine, par exemple « - Au goût : poivre ».
Retourne UNIQUEMENT un objet JSON valide avec la structure exacte suivante :
{
  "title": "Titre propre de la recette",
  "author": "Auteur si visible, sinon 'Inconnu'",
  "sourceContent": "INGRÉDIENTS :\\n- [quantité] [ingrédient]\\n- [quantité] [ingrédient]\\n\\nPRÉPARATION :\\n1. [étape 1]\\n2. [étape 2]",
  "suggestedTags": ["Sélectionne parmi : ${TAGS.join(', ')}"],
  "rating": 4
}`;

function parseRecipe(text) {
  const clean = String(text || '').replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Réponse sans JSON');
  const raw = JSON.parse(clean.slice(start, end + 1));
  const rating = parseInt(raw.rating, 10);
  return {
    title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '',
    author: typeof raw.author === 'string' ? raw.author.slice(0, 100) : '',
    sourceContent: typeof raw.sourceContent === 'string' ? raw.sourceContent.slice(0, 20000) : '',
    suggestedTags: Array.isArray(raw.suggestedTags) ? raw.suggestedTags.filter(t => TAGS.includes(t)) : [],
    rating: rating >= 1 && rating <= 5 ? rating : 4,
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée.' });
  }

  // Refuse les appels venant d'un autre site (le navigateur envoie l'en-tête Origin).
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ error: 'Origine non autorisée.' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'Origine non autorisée.' });
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "La variable d'environnement GEMINI_API_KEY n'est pas configurée sur Vercel." });
  }

  const files = req.body && req.body.files;
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
    return res.status(400).json({ error: `Envoyez entre 1 et ${MAX_FILES} documents.` });
  }
  let total = 0;
  for (const f of files) {
    if (!f || typeof f.data !== 'string' || !ALLOWED_MIME.test(f.mime_type || '')) {
      return res.status(400).json({ error: 'Seuls les images et les PDF peuvent être analysés.' });
    }
    total += f.data.length;
  }
  if (total > MAX_TOTAL_CHARS) {
    return res.status(413).json({ error: 'Documents trop volumineux pour une seule analyse. Retirez-en ou analysez-les en plusieurs fois.' });
  }

  const parts = [{ text: PROMPT }, ...files.map(f => ({ inline_data: { mime_type: f.mime_type, data: f.data } }))];
  let lastError = 'Aucun modèle disponible.';

  for (const model of MODELS) {
    for (const withThinking of model.thinking ? [true, false] : [false]) {
      const generationConfig = { responseMimeType: 'application/json', temperature: 0.2 };
      if (withThinking) generationConfig.thinkingConfig = { thinkingLevel: 'low' };

      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({ contents: [{ parts }], generationConfig }),
            signal: AbortSignal.timeout(25000),
          }
        );
        const j = await r.json().catch(() => ({}));

        if (r.ok) {
          const text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
          try {
            return res.status(200).json({ recipe: parseRecipe(text), model: model.id });
          } catch (e) {
            lastError = `${model.id} : réponse illisible.`;
            break; // modèle suivant
          }
        }

        const msg = j.error?.message || `HTTP ${r.status}`;
        lastError = `${model.id} : ${msg}`;
        // Problème de clé : inutile d'essayer un autre modèle.
        if (r.status === 401 || r.status === 403 || /api key/i.test(msg)) {
          return res.status(502).json({ error: 'Clé API Gemini refusée par Google. Vérifiez GEMINI_API_KEY sur Vercel.' });
        }
        // Option "thinking" refusée : on réessaie le même modèle sans elle.
        if (r.status === 400 && withThinking && /think/i.test(msg)) continue;
        break; // modèle suivant (404 retiré, 429 quota, 5xx surcharge…)
      } catch (e) {
        lastError = `${model.id} : ${e.name === 'TimeoutError' ? 'délai dépassé' : e.message}`;
        break;
      }
    }
  }

  return res.status(502).json({ error: `L'analyse IA a échoué (${lastError}).` });
};
