import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ erro: "Método não permitido" });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trf-"));
  const videoPath = path.join(tmpDir, "video.mp4");
  const framesDir = path.join(tmpDir, "frames");
  fs.mkdirSync(framesDir);

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const boundary = req.headers["content-type"].split("boundary=")[1];
    const bodyStr = buffer.toString("binary");
    const parts = bodyStr.split("--" + boundary);

    let videoBuffer = null;
    let empresa = "";
    let linha = "";
    let meta = 10;

    for (const part of parts) {
      if (part.includes('name="video"')) {
        const start = part.indexOf("\r\n\r\n") + 4;
        const end = part.lastIndexOf("\r\n");
        videoBuffer = Buffer.from(part.slice(start, end), "binary");
      }
      if (part.includes('name="empresa"')) {
        empresa = part.split("\r\n\r\n")[1]?.trim() || "";
      }
      if (part.includes('name="linha"')) {
        linha = part.split("\r\n\r\n")[1]?.trim() || "";
      }
      if (part.includes('name="meta"')) {
        meta = parseInt(part.split("\r\n\r\n")[1]?.trim()) || 10;
      }
    }

    if (!videoBuffer) return res.status(400).json({ erro: "Vídeo não recebido" });
    fs.writeFileSync(videoPath, videoBuffer);

    try {
      execSync(`ffmpeg -i ${videoPath} -vf fps=1/5 -q:v 2 ${framesDir}/frame%03d.jpg`, { timeout: 60000 });
    } catch (e) {
      return res.status(500).json({ erro: "Erro ao processar vídeo. Verifique se o arquivo é válido." });
    }

    const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith(".jpg")).sort();
    if (frameFiles.length === 0) return res.status(500).json({ erro: "Nenhum frame extraído do vídeo." });

    const framesSample = frameFiles.slice(0, 12);
    const imagesContent = framesSample.map((f, i) => {
      const imgData = fs.readFileSync(path.join(framesDir, f));
      return {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: imgData.toString("base64") }
      };
    });

    const duracaoEstimada = frameFiles.length * 5;

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

Analise estes frames de uma filmagem de setup industrial da linha "${linha}" da empresa "${empresa}".
Duração estimada do vídeo: ${duracaoEstimada} segundos. Meta de setup: ${meta} minutos.

Identifique todas as atividades de setup visíveis nos frames e classifique cada uma.

REGRAS OBRIGATÓRIAS:
- Setup EXTERNO: pode ser feito com a máquina produzindo o lote anterior (buscar ferramentas, separar insumos, ler OP, pré-aquecer)
- Setup INTERNO: só pode ser feito com a máquina completamente parada (trocar matriz, limpar cabeçote, fixar ferramental, ajustar guias)

Retorne SOMENTE um JSON válido, sem texto antes ou depois, neste formato exato:
{
  "empresa": "${empresa}",
  "linha": "${linha}",
  "meta_minutos": ${meta},
  "duracao_total_segundos": ${duracaoEstimada},
  "tarefas": [
    {
      "tarefa": "nome da atividade observada",
      "tipo": "interno" ou "externo",
      "duracao_segundos": número estimado,
      "motivo": "justificativa técnica baseada em Shingo em 2 linhas",
      "oportunidade": "sugestão de melhoria ou conversão para externo"
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
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
}
