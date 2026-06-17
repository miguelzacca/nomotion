const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const uploadSection = document.getElementById('uploadSection');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');
const statusText = document.getElementById('statusText');
const statusSubtext = document.getElementById('statusSubtext');
const resultSection = document.getElementById('resultSection');
const originalVideo = document.getElementById('originalVideo');
const stabilizedVideo = document.getElementById('stabilizedVideo');
const btnDownload = document.getElementById('btnDownload');
const btnNew = document.getElementById('btnNew');

let currentFile = null;
let stabilizedUrl = null;

// Drag and Drop Events
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
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles(files);
});

dropZone.addEventListener('click', () => {
    fileInput.click();
});

fileInput.addEventListener('change', function() {
    handleFiles(this.files);
});

function handleFiles(files) {
    if (files.length === 0) return;
    const file = files[0];
    
    if (!file.type.startsWith('video/')) {
        alert('Por favor, envie um arquivo de vídeo válido.');
        return;
    }
    
    currentFile = file;
    startUploadAndProcessing(file);
}

function startUploadAndProcessing(file) {
    // UI Updates
    dropZone.style.display = 'none';
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.classList.remove('processing');
    statusText.innerText = 'Enviando vídeo...';
    statusSubtext.innerText = 'Fazendo o upload do arquivo para o servidor.';

    // Setup XHR for progress tracking
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('video', file);

    xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
            const percentComplete = (e.loaded / e.total) * 100;
            progressBar.style.width = percentComplete + '%';
            
            if (percentComplete === 100) {
                statusText.innerText = 'Processando vídeo...';
                statusSubtext.innerText = 'Aplicando algoritmos avançados de estabilização. Isso pode levar alguns minutos.';
                progressBar.classList.add('processing'); // Add shimmer animation
            }
        }
    });

    xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
            try {
                const response = JSON.parse(xhr.responseText);
                if (response.success) {
                    showResults(file, response.url);
                } else {
                    handleError(response.error || 'Erro desconhecido');
                }
            } catch (e) {
                handleError('Erro ao ler a resposta do servidor.');
            }
        } else {
            handleError('Erro no servidor durante o processamento.');
        }
    });

    xhr.addEventListener('error', () => {
        handleError('Erro de conexão ao enviar o arquivo.');
    });

    xhr.open('POST', '/api/stabilize', true);
    xhr.send(formData);
}

function handleError(msg) {
    alert('Ocorreu um erro: ' + msg);
    resetUI();
}

function showResults(originalFile, newUrl) {
    uploadSection.style.display = 'none';
    resultSection.style.display = 'block';
    stabilizedUrl = newUrl;

    // Set Original Video
    const originalUrl = URL.createObjectURL(originalFile);
    originalVideo.src = originalUrl;
    
    // Set Stabilized Video
    stabilizedVideo.src = newUrl;

    // Sync playback
    originalVideo.addEventListener('play', () => stabilizedVideo.play());
    originalVideo.addEventListener('pause', () => stabilizedVideo.pause());
    originalVideo.addEventListener('seeking', () => stabilizedVideo.currentTime = originalVideo.currentTime);
    
    stabilizedVideo.addEventListener('play', () => originalVideo.play());
    stabilizedVideo.addEventListener('pause', () => originalVideo.pause());
    stabilizedVideo.addEventListener('seeking', () => originalVideo.currentTime = stabilizedVideo.currentTime);
}

function resetUI() {
    uploadSection.style.display = 'block';
    dropZone.style.display = 'flex';
    progressContainer.style.display = 'none';
    resultSection.style.display = 'none';
    fileInput.value = '';
    currentFile = null;
    if (originalVideo.src) {
        URL.revokeObjectURL(originalVideo.src);
        originalVideo.src = '';
    }
    stabilizedVideo.src = '';
}

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
