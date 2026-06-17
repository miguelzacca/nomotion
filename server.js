const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const port = process.env.PORT || 3000;

// Setup directories
const uploadDir = path.join(__dirname, 'uploads');
const processedDir = path.join(__dirname, 'public', 'processed');

if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(processedDir)) fs.mkdirSync(processedDir, { recursive: true });

// Configure Multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

app.use(express.static('public'));

// ============================================================
// Quality Profiles
// ============================================================
const PROFILES = {
  fast: {
    detect: { stepsize: 16, shakiness: 8, accuracy: 9, mincontrast: 0.3 },
    transform: { smoothing: 10, interpol: 'bilinear', optzoom: 1, zoomspeed: 0.25, crop: 'black', optalgo: 'gauss' },
    encode: { preset: 'fast', crf: 23 },
    passes: 1
  },
  balanced: {
    detect: { stepsize: 6, shakiness: 10, accuracy: 12, mincontrast: 0.25 },
    transform: { smoothing: 20, interpol: 'bicubic', optzoom: 1, zoomspeed: 0.25, crop: 'black', optalgo: 'gauss' },
    encode: { preset: 'medium', crf: 20 },
    passes: 1
  },
  max: {
    detect: { stepsize: 4, shakiness: 10, accuracy: 15, mincontrast: 0.2 },
    transform: { smoothing: 30, interpol: 'bicubic', optzoom: 1, zoomspeed: 0.2, crop: 'black', optalgo: 'gauss' },
    encode: { preset: 'slow', crf: 18 },
    passes: 1
  },
  extreme: {
    detect: { stepsize: 2, shakiness: 10, accuracy: 15, mincontrast: 0.05 },
    transform: { smoothing: 120, interpol: 'bicubic', optzoom: 2, zoomspeed: 0.1, crop: 'black', optalgo: 'gauss' },
    encode: { preset: 'slower', crf: 15 },
    passes: 3,
    denoise: true
  },
  gimbal: {
    detect: { stepsize: 2, shakiness: 10, accuracy: 15, mincontrast: 0.05 },
    transform: { smoothing: 60, interpol: 'bicubic', optzoom: 2, zoomspeed: 0.1, crop: 'black', optalgo: 'gauss' },
    encode: { preset: 'slower', crf: 15 },
    passes: 3,
    denoise: true,
    fps60: true
  }
};

// ============================================================
// SSE Connections Map (jobId -> response)
// ============================================================
const sseClients = new Map();

// SSE endpoint for real-time progress
app.get('/api/progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ stage: 'connected' })}\n\n`);

  sseClients.set(jobId, res);

  req.on('close', () => {
    sseClients.delete(jobId);
  });
});

function sendProgress(jobId, data) {
  const client = sseClients.get(jobId);
  if (client) {
    client.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// ============================================================
// Get video duration using ffprobe
// ============================================================
function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

// ============================================================
// Parse FFmpeg progress output
// ============================================================
function parseProgress(stderrLine, totalDuration) {
  // FFmpeg outputs lines like: frame=  120 fps=30 ... time=00:00:04.00 ...
  const timeMatch = stderrLine.match(/time=(\d+):(\d+):(\d+\.\d+)/);
  const speedMatch = stderrLine.match(/speed=\s*([\d.]+)x/);
  const fpsMatch = stderrLine.match(/fps=\s*([\d.]+)/);

  if (timeMatch && totalDuration > 0) {
    const hours = parseFloat(timeMatch[1]);
    const minutes = parseFloat(timeMatch[2]);
    const seconds = parseFloat(timeMatch[3]);
    const currentTime = hours * 3600 + minutes * 60 + seconds;
    const percent = Math.min(99, Math.round((currentTime / totalDuration) * 100));
    const speed = speedMatch ? parseFloat(speedMatch[1]) : null;
    const fps = fpsMatch ? parseFloat(fpsMatch[1]) : null;

    // Estimate remaining time
    let eta = null;
    if (speed && speed > 0) {
      const remainingDuration = totalDuration - currentTime;
      eta = Math.round(remainingDuration / speed);
    }

    return { percent, speed, fps, eta, currentTime, totalDuration };
  }
  return null;
}

// ============================================================
// Upload + Stabilize endpoint (supports multi-pass)
// ============================================================
app.post('/api/stabilize', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum vídeo enviado.' });
  }

  const profileKey = req.body.quality || 'max';
  const profile = PROFILES[profileKey] || PROFILES.max;
  const passes = profile.passes || 1;
  const totalSteps = passes * 2;

  const inputPath = req.file.path;
  const filename = path.basename(inputPath);
  const outputPath = path.join(processedDir, filename);
  const jobId = path.parse(filename).name;

  console.log(`[${jobId}] Iniciando estabilização | Perfil: ${profileKey} | Passes: ${passes} | Arquivo: ${req.file.originalname}`);

  let totalDuration = 0;
  try {
    totalDuration = await getVideoDuration(inputPath);
    console.log(`[${jobId}] Duração do vídeo: ${totalDuration.toFixed(1)}s`);
  } catch (e) {
    console.error(`[${jobId}] Erro ao obter duração:`, e);
  }

  // Send jobId immediately so client can connect to SSE
  res.json({ jobId, status: 'processing' });

  const d = profile.detect;
  const t = profile.transform;

  // Polish filters: denoise + optical flow 60fps + sharpen on final pass only
  let finalFilters = '';
  if (profile.denoise) finalFilters += ',hqdn3d=4:3:6:4.5';
  if (profile.fps60) finalFilters += ',minterpolate=fps=60:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1';
  finalFilters += ',unsharp=5:5:0.8:3:3:0.4';

  const tempFiles = [inputPath];

  try {
    let currentInput = inputPath;

    for (let pass = 1; pass <= passes; pass++) {
      const trfFileName = `${filename}_pass${pass}.trf`;
      const absoluteTrfPath = path.join(uploadDir, trfFileName);
      // No Windows, caminhos absolutos com "C:/" falham dentro de filtros do FFmpeg.
      const relativeTrfPath = path.relative(process.cwd(), absoluteTrfPath).replace(/\\/g, '/');
      tempFiles.push(absoluteTrfPath);

      const detectStepNum = pass * 2 - 1;
      const transformStepNum = pass * 2;
      const isLastPass = pass === passes;

      const passOutput = isLastPass
        ? outputPath
        : path.join(uploadDir, `${jobId}_intermediate_p${pass}.mp4`);
      if (!isLastPass) tempFiles.push(passOutput);

      // Progressive smoothing: each pass targets increasingly fine tremors
      // Pass 1/3 = 33% smoothing (big shakes), Pass 2/3 = 66% (medium), Pass 3/3 = 100% (micro-tremors)
      const passSmoothing = passes > 1 ? Math.max(10, Math.round(t.smoothing * (pass / passes))) : t.smoothing;

      const detectFilter = `vidstabdetect=stepsize=${d.stepsize}:shakiness=${d.shakiness}:accuracy=${d.accuracy}:mincontrast=${d.mincontrast}:result=${relativeTrfPath}`;
      const extraFilters = isLastPass ? finalFilters : ',unsharp=5:5:0.5:3:3:0.3';
      const transformFilter = `vidstabtransform=input=${relativeTrfPath}:smoothing=${passSmoothing}:optalgo=${t.optalgo}:interpol=${t.interpol}:crop=${t.crop}:optzoom=${t.optzoom}:zoomspeed=${t.zoomspeed}${extraFilters}`;

      // ---- DETECT ----
      sendProgress(jobId, { stage: 'detecting', percent: 0, step: detectStepNum, totalSteps, pass, totalPasses: passes });

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(currentInput)
          .outputOptions([`-vf ${detectFilter}`, '-f null']);

        cmd.on('start', (c) => console.log(`[${jobId}] Passo ${detectStepNum}/${totalSteps} CMD:`, c));
        cmd.on('stderr', (line) => {
          const progress = parseProgress(line, totalDuration);
          if (progress) {
            sendProgress(jobId, { stage: 'detecting', step: detectStepNum, totalSteps, pass, totalPasses: passes, ...progress });
          }
        });
        cmd.on('error', (err) => reject(err));
        cmd.on('end', () => resolve());
        cmd.save('-');
      });

      console.log(`[${jobId}] Passo ${detectStepNum}/${totalSteps} concluído.`);

      // ---- TRANSFORM ----
      sendProgress(jobId, { stage: 'transforming', percent: 0, step: transformStepNum, totalSteps, pass, totalPasses: passes });

      // Intermediate passes use CRF 14 to preserve maximum quality for the next pass
      const encodeCrf = isLastPass ? profile.encode.crf : 14;
      const encodePreset = isLastPass ? profile.encode.preset : 'medium';

      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(currentInput)
          .outputOptions([
            `-vf ${transformFilter}`,
            `-c:v libx264`,
            `-preset ${encodePreset}`,
            `-crf ${encodeCrf}`,
            `-c:a copy`
          ]);

        cmd.on('start', (c) => console.log(`[${jobId}] Passo ${transformStepNum}/${totalSteps} CMD:`, c));
        cmd.on('stderr', (line) => {
          const progress = parseProgress(line, totalDuration);
          if (progress) {
            sendProgress(jobId, { stage: 'transforming', step: transformStepNum, totalSteps, pass, totalPasses: passes, ...progress });
          }
        });
        cmd.on('error', (err) => reject(err));
        cmd.on('end', () => resolve());
        cmd.save(passOutput);
      });

      console.log(`[${jobId}] Passo ${transformStepNum}/${totalSteps} concluído.`);
      currentInput = passOutput;
    }

    console.log(`[${jobId}] Estabilização completa!`);
    sendProgress(jobId, {
      stage: 'done',
      percent: 100,
      url: `/processed/${filename}`,
      originalName: req.file.originalname
    });
    cleanup(...tempFiles.filter(f => f !== outputPath));

  } catch (err) {
    console.error(`[${jobId}] Erro na estabilização:`, err.message);
    sendProgress(jobId, { stage: 'error', error: 'Erro na estabilização do vídeo.' });
    cleanup(...tempFiles);
  }
});

// ============================================================
// Status endpoint (poll fallback)
// ============================================================
app.get('/api/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  // Check if the processed file exists
  const files = fs.readdirSync(processedDir);
  const match = files.find(f => f.startsWith(jobId));
  if (match) {
    res.json({ status: 'done', url: `/processed/${match}` });
  } else {
    res.json({ status: 'processing' });
  }
});

// ============================================================
// Cleanup temp files
// ============================================================
function cleanup(...files) {
  for (const file of files) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) {
      console.error('Erro ao limpar temp:', e.message);
    }
  }
}

app.listen(port, () => {
  console.log(`Servidor NoMotion rodando em http://localhost:${port}`);
});
