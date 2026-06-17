// ============================================================
// DOM Elements
// ============================================================
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadSection = document.getElementById('uploadSection');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const statusText = document.getElementById('statusText');
const statusSubtext = document.getElementById('statusSubtext');
const progressStep = document.getElementById('progressStep');
const progressPercent = document.getElementById('progressPercent');
const progressEta = document.getElementById('progressEta');
const progressStats = document.getElementById('progressStats');
const statSpeed = document.getElementById('statSpeed');
const statFps = document.getElementById('statFps');
const statEta = document.getElementById('statEta');
const resultSection = document.getElementById('resultSection');
const originalVideo = document.getElementById('originalVideo');
const stabilizedVideo = document.getElementById('stabilizedVideo');
const btnDownload = document.getElementById('btnDownload');
const btnNew = document.getElementById('btnNew');
const profileCards = document.querySelectorAll('.profile-card');

let currentFile = null;
let stabilizedUrl = null;
let eventSource = null;

// ============================================================
// Profile Selection
// ============================================================
profileCards.forEach(card => {
    card.addEventListener('click', () => {
        profileCards.forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        card.querySelector('input').checked = true;
    });
});

function getSelectedProfile() {
    const checked = document.querySelector('input[name="quality"]:checked');
    return checked ? checked.value : 'max';
}

// ============================================================
// Drag and Drop Events
// ============================================================
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
});

dropZone.addEventListener('drop', (e) => {
    handleFiles(e.dataTransfer.files);
});

dropZone.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', function () {
    handleFiles(this.files);
});

// ============================================================
// File Handling
// ============================================================
function handleFiles(files) {
    if (files.length === 0) return;
    const file = files[0];

    if (!file.type.startsWith('video/')) {
        showToast('Por favor, envie um arquivo de vídeo válido.', 'error');
        return;
    }

    currentFile = file;
    startUploadAndProcessing(file);
}

// ============================================================
// Upload + SSE Processing
// ============================================================
function startUploadAndProcessing(file) {
    // Show progress UI
    dropZone.style.display = 'none';
    document.getElementById('profileSelector').style.display = 'none';
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.classList.remove('processing');
    progressStats.style.display = 'none';
    statusText.innerText = 'Enviando vídeo...';
    statusSubtext.innerText = 'Fazendo upload do arquivo para o servidor.';
    progressStep.innerText = 'Upload';
    progressPercent.innerText = '0%';
    progressEta.innerText = '';

    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('video', file);
    formData.append('quality', getSelectedProfile());

    // Upload progress
    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressBar.style.width = pct + '%';
            progressPercent.innerText = pct + '%';

            if (pct === 100) {
                statusText.innerText = 'Upload completo!';
                statusSubtext.innerText = 'Conectando ao processador...';
                progressBar.classList.add('processing');
            }
        }
    });

    xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
            try {
                const response = JSON.parse(xhr.responseText);
                if (response.jobId) {
                    connectSSE(response.jobId);
                } else if (response.error) {
                    handleError(response.error);
                }
            } catch (e) {
                handleError('Erro ao ler a resposta do servidor.');
            }
        } else {
            handleError('Erro no servidor durante o upload.');
        }
    });

    xhr.addEventListener('error', () => {
        handleError('Erro de conexão ao enviar o arquivo.');
    });

    xhr.open('POST', '/api/stabilize', true);
    xhr.send(formData);
}

// ============================================================
// SSE Real-time Progress
// ============================================================
function connectSSE(jobId) {
    if (eventSource) {
        eventSource.close();
    }

    eventSource = new EventSource(`/api/progress/${jobId}`);

    eventSource.addEventListener('message', (event) => {
        const data = JSON.parse(event.data);

        switch (data.stage) {
            case 'connected':
                statusText.innerText = 'Conectado ao processador';
                statusSubtext.innerText = 'Iniciando análise de movimento...';
                break;

            case 'detecting':
                progressBar.classList.remove('processing');
                progressStats.style.display = 'flex';
                if (data.pass && data.pass > 1) {
                    statusText.innerText = `Refinando análise (passada ${data.pass}/${data.totalPasses})...`;
                    statusSubtext.innerText = 'Varredura adicional para capturar tremores residuais.';
                } else {
                    statusText.innerText = 'Analisando movimentos...';
                    statusSubtext.innerText = 'Detectando tremidas e padrões de movimento no vídeo.';
                }
                progressStep.innerText = `Passo ${data.step} de ${data.totalSteps}`;
                if (data.percent !== undefined) {
                    const stepWeight = 100 / data.totalSteps;
                    const overall = Math.round((data.step - 1) * stepWeight + data.percent * stepWeight / 100);
                    progressBar.style.width = overall + '%';
                    progressPercent.innerText = overall + '%';
                }
                updateStats(data);
                break;

            case 'transforming':
                progressBar.classList.remove('processing');
                progressStats.style.display = 'flex';
                if (data.pass && data.pass === data.totalPasses && data.totalPasses > 1) {
                    statusText.innerText = 'Polimento final...';
                    statusSubtext.innerText = 'Estabilização de precisão + redução de ruído.';
                } else if (data.pass && data.pass < data.totalPasses) {
                    statusText.innerText = `Estabilizando (passada ${data.pass}/${data.totalPasses})...`;
                    statusSubtext.innerText = 'Removendo tremidas do vídeo.';
                } else {
                    statusText.innerText = 'Aplicando estabilização...';
                    statusSubtext.innerText = 'Transformando frames com correção de movimento.';
                }
                progressStep.innerText = `Passo ${data.step} de ${data.totalSteps}`;
                if (data.percent !== undefined) {
                    const stepWeight = 100 / data.totalSteps;
                    const overall = Math.round((data.step - 1) * stepWeight + data.percent * stepWeight / 100);
                    progressBar.style.width = overall + '%';
                    progressPercent.innerText = overall + '%';
                }
                updateStats(data);
                break;

            case 'done':
                progressBar.style.width = '100%';
                progressPercent.innerText = '100%';
                progressBar.classList.add('done');
                statusText.innerText = 'Estabilização completa!';
                statusSubtext.innerText = 'Preparando resultado...';
                progressStats.style.display = 'none';

                if (eventSource) {
                    eventSource.close();
                    eventSource = null;
                }

                setTimeout(() => {
                    showResults(currentFile, data.url);
                }, 800);
                break;

            case 'error':
                if (eventSource) {
                    eventSource.close();
                    eventSource = null;
                }
                handleError(data.error || 'Erro desconhecido no processamento.');
                break;
        }
    });

    eventSource.addEventListener('error', () => {
        // SSE disconnected — try polling as fallback
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        startPolling(jobId);
    });
}

// ============================================================
// Polling Fallback
// ============================================================
function startPolling(jobId) {
    statusText.innerText = 'Processando vídeo...';
    statusSubtext.innerText = 'Conexão em tempo real perdida. Verificando status...';
    progressBar.classList.add('processing');
    progressStats.style.display = 'none';

    const pollInterval = setInterval(async () => {
        try {
            const resp = await fetch(`/api/status/${jobId}`);
            const data = await resp.json();
            if (data.status === 'done') {
                clearInterval(pollInterval);
                progressBar.style.width = '100%';
                progressBar.classList.remove('processing');
                progressBar.classList.add('done');
                setTimeout(() => {
                    showResults(currentFile, data.url);
                }, 500);
            }
        } catch (e) {
            // Keep polling
        }
    }, 3000);
}

// ============================================================
// Update Stats Display
// ============================================================
function updateStats(data) {
    if (data.speed !== null && data.speed !== undefined) {
        statSpeed.innerText = data.speed.toFixed(2) + 'x';
    }
    if (data.fps !== null && data.fps !== undefined) {
        statFps.innerText = Math.round(data.fps);
    }
    if (data.eta !== null && data.eta !== undefined) {
        statEta.innerText = formatEta(data.eta);
        progressEta.innerText = 'ETA: ' + formatEta(data.eta);
    }
}

function formatEta(seconds) {
    if (seconds <= 0) return 'Quase lá...';
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
}

// ============================================================
// Error Handling
// ============================================================
function handleError(msg) {
    showToast('Erro: ' + msg, 'error');
    resetUI();
}

function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ============================================================
// Show Results
// ============================================================
function showResults(originalFile, newUrl) {
    uploadSection.style.display = 'none';
    resultSection.style.display = 'block';
    stabilizedUrl = newUrl;

    const originalUrl = URL.createObjectURL(originalFile);
    originalVideo.src = originalUrl;
    stabilizedVideo.src = newUrl;

    // Sync playback — avoid infinite loops with flags
    let syncing = false;

    originalVideo.addEventListener('play', () => {
        if (!syncing) { syncing = true; stabilizedVideo.play().finally(() => syncing = false); }
    });
    originalVideo.addEventListener('pause', () => {
        if (!syncing) { syncing = true; stabilizedVideo.pause(); syncing = false; }
    });
    originalVideo.addEventListener('seeking', () => {
        stabilizedVideo.currentTime = originalVideo.currentTime;
    });

    stabilizedVideo.addEventListener('play', () => {
        if (!syncing) { syncing = true; originalVideo.play().finally(() => syncing = false); }
    });
    stabilizedVideo.addEventListener('pause', () => {
        if (!syncing) { syncing = true; originalVideo.pause(); syncing = false; }
    });
    stabilizedVideo.addEventListener('seeking', () => {
        originalVideo.currentTime = stabilizedVideo.currentTime;
    });
}

// ============================================================
// Reset UI
// ============================================================
function resetUI() {
    uploadSection.style.display = 'block';
    dropZone.style.display = 'flex';
    document.getElementById('profileSelector').style.display = 'block';
    progressContainer.style.display = 'none';
    resultSection.style.display = 'none';
    progressBar.classList.remove('processing', 'done');
    fileInput.value = '';
    currentFile = null;

    if (originalVideo.src) {
        URL.revokeObjectURL(originalVideo.src);
        originalVideo.src = '';
    }
    stabilizedVideo.src = '';

    if (eventSource) {
        eventSource.close();
        eventSource = null;
    }
}

// ============================================================
// Button Handlers
// ============================================================
btnDownload.addEventListener('click', () => {
    if (!stabilizedUrl) return;
    const a = document.createElement('a');
    a.href = stabilizedUrl;
    a.download = 'stabilized_video.mp4';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
});

btnNew.addEventListener('click', resetUI);
