// Fonction serverless Vercel : /api/analyze
// - { files: [...] } : extraction à partir de photos / PDF
// - { url: "https://..." } : extraction à partir d'une page web
// La clé Gemini reste ici (variable d'environnement GEMINI_API_KEY), jamais dans le navigateur.

const dns = require('dns').promises;
const net = require('net');

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

const INTRO_DOCS = `Analyse le ou les document(s) fourni(s) qui composent une recette de cuisine (pages de livre, fiches manuscrites, fiches imprimées, etc.). Regroupe, déduis et reformate toutes les informations pour créer une fiche uniforme, en français, sans rien inventer : conserve les quantités et les temps d'origine.`;
const INTRO_WEB = `Voici le contenu extrait d'une page web de recette (titre, données structurées éventuelles, texte de la page). Ignore les publicités, commentaires et menus. Reformate la recette pour créer une fiche uniforme, en français, sans rien inventer : conserve les quantités et les temps d'origine.`;

const FORMAT = `
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

// ---------- Lecture sécurisée d'une page web ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) {
    const rest = v.slice(7);
    return rest.includes('.') ? isPrivateIp(rest) : true; // forme hexadécimale : on refuse par prudence
  }
  return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

// Refuse les adresses locales ou privées (évite que le serveur serve de relais vers un réseau interne).
async function assertPublicUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch (e) { throw new Error('Lien invalide.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Seuls les liens http(s) sont acceptés.');
  if (u.port && u.port !== '80' && u.port !== '443') throw new Error('Port non autorisé.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('Adresse non autorisée.');
    return u;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { throw new Error("Impossible de trouver ce site."); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('Adresse non autorisée.');
  return u;
}

async function fetchPage(urlStr) {
  let current = urlStr;
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(current);
    const r = await fetch(u.toString(), {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ATableBot/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr,en;q=0.8',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location'), u).toString();
      continue;
    }
    if (!r.ok) throw new Error(`Le site a répondu avec l'erreur ${r.status}.`);
    const type = r.headers.get('content-type') || '';
    if (!/html|xml|text\/plain/i.test(type)) throw new Error("Ce lien ne pointe pas vers une page web lisible.");

    // Lecture limitée à ~2 Mo
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > 2000000) { await reader.cancel(); break; }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new Error('Trop de redirections.');
}

function decodeEntities(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function extractPageText(html) {
  const title = decodeEntities(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim());

  // Beaucoup de sites de recettes publient les données propres de la recette en JSON-LD.
  const ld = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/"Recipe"|recipeIngredient/i.test(m[1])) ld.push(m[1].trim().slice(0, 15000));
  }

  let text = html
    .replace(/<(script|style|noscript|svg|nav|footer|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text).replace(/[ \t\r\f\v]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, 30000);

  if (ld.length === 0 && text.length < 200) {
    throw new Error("La page ne contient pas de texte exploitable (elle est peut-être chargée par JavaScript ou protégée).");
  }
  return `TITRE DE LA PAGE : ${title}\n\n` +
    (ld.length ? `DONNÉES STRUCTURÉES (JSON-LD) :\n${ld.join('\n')}\n\n` : '') +
    `TEXTE DE LA PAGE :\n${text}`;
}

// ---------- Appel Gemini avec bascule de modèles ----------

async function runGemini(parts, apiKey) {
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
            return { recipe: parseRecipe(text), model: model.id };
          } catch (e) {
            lastError = `${model.id} : réponse illisible.`;
            break; // modèle suivant
          }
        }

        const msg = j.error?.message || `HTTP ${r.status}`;
        lastError = `${model.id} : ${msg}`;
        // Problème de clé : inutile d'essayer un autre modèle.
        if (r.status === 401 || r.status === 403 || /api key/i.test(msg)) {
          throw Object.assign(new Error('Clé API Gemini refusée par Google. Vérifiez GEMINI_API_KEY sur Vercel.'), { fatal: true });
        }
        // Option "thinking" refusée : on réessaie le même modèle sans elle.
        if (r.status === 400 && withThinking && /think/i.test(msg)) continue;
        break; // modèle suivant (404 retiré, 429 quota, 5xx surcharge…)
      } catch (e) {
        if (e.fatal) throw e;
        lastError = `${model.id} : ${e.name === 'TimeoutError' ? 'délai dépassé' : e.message}`;
        break;
      }
    }
  }
  throw new Error(`L'analyse IA a échoué (${lastError}).`);
}

// ---------- Point d'entrée ----------

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

  const body = req.body || {};
  let parts;

  if (typeof body.url === 'string' && body.url.trim()) {
    // --- Extraction depuis un lien ---
    try {
      const html = await fetchPage(body.url.trim());
      parts = [{ text: `${INTRO_WEB}\n${FORMAT}\n\n=== PAGE WEB ===\n${extractPageText(html)}` }];
    } catch (e) {
      return res.status(422).json({ error: e.name === 'TimeoutError' ? 'Le site met trop de temps à répondre.' : e.message });
    }
  } else {
    // --- Extraction depuis des photos / PDF ---
    const files = body.files;
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
    parts = [{ text: `${INTRO_DOCS}\n${FORMAT}` },
      ...files.map(f => ({ inline_data: { mime_type: f.mime_type, data: f.data } }))];
  }

  try {
    return res.status(200).json(await runGemini(parts, apiKey));
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
