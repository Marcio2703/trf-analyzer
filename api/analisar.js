import Anthropic from "@anthropic-ai/sdk";

export const config = { api: { bodyParser: true } };

async function urlToBase64(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString("base64");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  try {
    const { empresa, linha, meta, publicId, duration } = req.body;
    if (!publicId) return res.status(400).json({ erro: "publicId do vídeo não recebido" });

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const dur = parseFloat(duration) || 60;
    const frameCount = Math.min(10, Math.ceil(dur / 5));
    const frameUrls = [];

    for (let i = 0; i < frameCount; i++) {
      const offset = Math.round((i / frameCount) * dur);
      const url = `https://res.cloudinary.com/${cloudName}/video/upload/so_${offset},f_jpg,w_800/${publicId}.jpg`;
      frameUrls.push(url);
    }

    const imagesContent = (await Promise.all(
      frameUrls.map(async (url) => {
        try {
          const b64 = await urlToBase64(url);
          return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } };
        } catch { return null; }
      })
    )).filter(Boolean);

    if (imagesContent.length === 0) {
      return res.status(500).json({ erro: "Não foi possível extrair frames do vídeo" });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          ...imagesContent,
          {
            type: "text",
            text: `Você é especialista em TRF (Troca Rápida de Ferramenta) baseado em Shigeo Shingo (1985).

Analise os frames desta filmagem de setup industrial.
Empresa: "${empresa}" | Linha: "${linha}" | Meta: ${meta} minutos | Duração: ${Math.round(dur)}s

REGRAS OBRIGATÓRIAS:
- Setup EXTERNO: pode ser feito com máquina produzindo o lote anterior
- Setup INTERNO: só com máquina completamente parada

Retorne SOMENTE JSON válido sem texto adicional:
{
  "empresa": "${empresa}",
  "linha": "${linha}",
  "meta_minutos": ${meta},
  "duracao_total_segundos": ${Math.round(dur)},
  "tarefas": [
    {
      "tarefa": "nome da atividade observada",
      "tipo": "interno",
      "duracao_segundos": 60,
      "motivo": "justificativa técnica em 2 linhas baseada em Shingo",
      "oportunidade": "sugestão de melhoria"
    }
  ]
}`
          }
        ]
      }]
    });

    const rawText = response.content.map(b => b.text || "").join("");
    const clean = rawText.replace(/```json|```/g, "").trim();
    const resultado = JSON.parse(clean);

    const interno = resultado.tarefas.filter(t => t.tipo === "interno").reduce((a, b) => a + b.duracao_segundos, 0);
    const externo = resultado.tarefas.filter(t => t.tipo === "externo").reduce((a, b) => a + b.duracao_segundos, 0);
    resultado.resumo = {
      total_segundos: interno + externo,
      interno_segundos: interno,
      externo_segundos: externo,
      potencial_reducao_segundos: externo,
      percentual_interno: Math.round(interno / (interno + externo) * 100),
      percentual_externo: Math.round(externo / (interno + externo) * 100),
      meta_atingida: (interno + externo) / 60 <= meta
    };

    return res.status(200).json(resultado);

  } catch (err) {
    return res.status(500).json({ erro: "Erro interno: " + err.message });
  }
}
