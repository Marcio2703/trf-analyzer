import Anthropic from "@anthropic-ai/sdk";
import { v2 as cloudinary } from "cloudinary";

export const config = { api: { bodyParser: false } };

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function parseMultipart(req) {
  const buffer = await streamToBuffer(req);
  const boundary = req.headers["content-type"].split("boundary=")[1];
  const parts = buffer.toString("binary").split("--" + boundary);
  const result = { fields: {}, videoBuffer: null };
  for (const part of parts) {
    if (part.includes("Content-Disposition")) {
      const nameMatch = part.match(/name="([^"]+)"/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      const start = part.indexOf("\r\n\r\n") + 4;
      const end = part.lastIndexOf("\r\n");
      if (part.includes("filename=")) {
        result.videoBuffer = Buffer.from(part.slice(start, end), "binary");
      } else {
        result.fields[name] = part.slice(start, end).trim();
      }
    }
  }
  return result;
}

async function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: "video", folder: "trf-analyzer", eager: [{ format: "jpg", transformation: [{ width: 800 }] }] },
      (error, result) => { if (error) reject(error); else resolve(result); }
    );
    stream.end(buffer);
  });
}

async function extractFrames(publicId, durationSeconds) {
  const frameCount = Math.min(12, Math.ceil(durationSeconds / 5));
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const offset = Math.round((i / frameCount) * durationSeconds);
    const url = cloudinary.url(publicId, {
      resource_type: "video",
      format: "jpg",
      transformation: [{ width: 800, crop: "scale" }, { start_offset: offset }],
    });
    frames.push(url);
  }
  return frames;
}

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

  let cloudinaryPublicId = null;

  try {
    const { fields, videoBuffer } = await parseMultipart(req);
    if (!videoBuffer) return res.status(400).json({ erro: "Vídeo não recebido" });

    const empresa = fields.empresa || "Não informado";
    const linha = fields.linha || "Não informado";
    const meta = parseInt(fields.meta) || 10;

    const uploadResult = await uploadToCloudinary(videoBuffer);
    cloudinaryPublicId = uploadResult.public_id;
    const duration = uploadResult.duration || 60;

    const frameUrls = await extractFrames(cloudinaryPublicId, duration);

    const imagesContent = await Promise.all(
      frameUrls.map(async (url) => {
        try {
          const b64 = await urlToBase64(url);
          return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } };
        } catch { return null; }
      })
    );
    const validImages = imagesContent.filter(Boolean);

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: [
          ...validImages,
          {
            type: "text",
            text: `Você é especialista em TRF (Troca Rápida de Ferramenta) baseado em Shigeo Shingo (1985).

Analise os frames desta filmagem de setup industrial.
Empresa: "${empresa}" | Linha: "${linha}" | Meta: ${meta} minutos | Duração: ${Math.round(duration)}s

REGRAS:
- Setup EXTERNO: pode ser feito com máquina produzindo (buscar ferramentas, separar insumos, ler OP, pré-aquecer)
- Setup INTERNO: só com máquina completamente parada (trocar matriz, limpar cabeçote, fixar ferramental, ajustar guias)

Retorne SOMENTE JSON válido sem texto adicional:
{
  "empresa": "${empresa}",
  "linha": "${linha}",
  "meta_minutos": ${meta},
  "duracao_total_segundos": ${Math.round(duration)},
  "tarefas": [
    {
      "tarefa": "nome da atividade",
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
  } finally {
    if (cloudinaryPublicId) {
      cloudinary.uploader.destroy(cloudinaryPublicId, { resource_type: "video" }).catch(() => {});
    }
  }
}
