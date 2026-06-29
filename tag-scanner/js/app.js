import { getRecords, saveRecord, updateRecord, deleteRecord, exportCSV, getSettings } from './storage.js';

// --- State ---
let stream = null;
let capturedBlob = null;
let cameraActive = false;

// --- DOM ---
const video = document.getElementById('video');
const previewImg = document.getElementById('preview-img');
const statusBar = document.getElementById('status-bar');
const statusMsg = document.getElementById('status-msg');
const resultCard = document.getElementById('result-card');
const fieldName = document.getElementById('field-name');
const fieldPrice = document.getElementById('field-price');
const ocrRaw = document.getElementById('ocr-raw');
const recordsList = document.getElementById('records-list');
const scanOverlay = document.querySelector('.scan-overlay');
const scanPlaceholder = document.querySelector('.scan-placeholder');

// --- Buttons ---
const btnCamera = document.getElementById('btn-camera');
const btnCapture = document.getElementById('btn-capture');
const btnUpload = document.getElementById('btn-upload');
const btnSave = document.getElementById('btn-save');
const btnStripe = document.getElementById('btn-stripe');
const btnDiscard = document.getElementById('btn-discard');
const btnExport = document.getElementById('btn-export');
const fileInput = document.getElementById('file-input');

// --- Camera ---
async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 } }
    });
    video.srcObject = stream;
    video.classList.remove('hidden');
    previewImg.classList.add('hidden');
    scanOverlay.style.display = 'flex';
    scanPlaceholder.style.display = 'none';
    btnCamera.textContent = 'Stop';
    btnCapture.disabled = false;
    cameraActive = true;
  } catch (err) {
    toast('Camera access denied', 'error');
  }
}

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.srcObject = null;
  video.classList.add('hidden');
  scanOverlay.style.display = 'none';
  scanPlaceholder.style.display = 'flex';
  btnCamera.textContent = 'Camera';
  btnCapture.disabled = true;
  cameraActive = false;
}

function captureFrame() {
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  canvas.toBlob(blob => {
    capturedBlob = blob;
    const url = URL.createObjectURL(blob);
    previewImg.src = url;
    previewImg.classList.remove('hidden');
    video.classList.add('hidden');
    scanOverlay.style.display = 'none';
    stopCamera();
    processImage(blob);
  }, 'image/jpeg', 0.92);
}

// --- File upload ---
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (!file) return;
  loadFile(file);
  fileInput.value = '';
});

// --- Drag and drop ---
const previewContainer = document.getElementById('preview-container');

previewContainer.addEventListener('dragover', e => {
  e.preventDefault();
  previewContainer.classList.add('drag-over');
});

previewContainer.addEventListener('dragleave', e => {
  if (!previewContainer.contains(e.relatedTarget)) {
    previewContainer.classList.remove('drag-over');
  }
});

previewContainer.addEventListener('drop', e => {
  e.preventDefault();
  previewContainer.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    loadFile(file);
  } else {
    toast('Drop an image file', 'error');
  }
});

function loadFile(file) {
  capturedBlob = file;
  const url = URL.createObjectURL(file);
  previewImg.src = url;
  previewImg.classList.remove('hidden');
  video.classList.add('hidden');
  scanOverlay.style.display = 'none';
  scanPlaceholder.style.display = 'none';
  if (cameraActive) stopCamera();
  processImage(file);
}

// --- OCR + AI ---
async function processImage(blob) {
  resultCard.classList.remove('visible');
  showStatus('Running OCR...');

  let rawText = '';
  try {
    rawText = await runOCR(blob);
  } catch (err) {
    showStatus('OCR failed: ' + err.message);
    return;
  }

  if (!rawText.trim()) {
    hideStatus();
    toast('No text detected — try better lighting', 'error');
    return;
  }

  const parsed = parseOCR(rawText);
  hideStatus();
  ocrRaw.textContent = rawText;
  fieldName.value = parsed.name || '';
  fieldPrice.value = parsed.price || '';
  resultCard.classList.add('visible');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function runOCR(blob) {
  const { createWorker } = Tesseract;
  const worker = await createWorker('eng', 1, {
    logger: m => {
      if (m.status === 'recognizing text') {
        showStatus(`OCR: ${Math.round(m.progress * 100)}%`);
      }
    }
  });
  const url = URL.createObjectURL(blob);
  const result = await worker.recognize(url);
  await worker.terminate();
  URL.revokeObjectURL(url);
  return result.data.text;
}

function parseOCR(rawText) {
  const name = rawText.split('\n').map(l => l.trim()).filter(Boolean).join(' ');
  return { name, price: '' };
}

// --- Stripe ---
async function pushToStripe(record) {
  const { stripeKey } = getSettings();
  if (!stripeKey) throw new Error('No Stripe secret key configured');

  const priceInCents = Math.round(parseFloat(record.price) * 100);
  if (isNaN(priceInCents) || priceInCents <= 0) throw new Error('Invalid price');

  // Create product
  const productRes = await fetch('https://api.stripe.com/v1/products', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ name: record.name })
  });
  if (!productRes.ok) {
    const err = await productRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Stripe product error ${productRes.status}`);
  }
  const product = await productRes.json();

  // Create price
  const priceRes = await fetch('https://api.stripe.com/v1/prices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      product: product.id,
      unit_amount: String(priceInCents),
      currency: 'usd'
    })
  });
  if (!priceRes.ok) {
    const err = await priceRes.json().catch(() => ({}));
    throw new Error(err.error?.message || `Stripe price error ${priceRes.status}`);
  }
  const price = await priceRes.json();
  return { productId: product.id, priceId: price.id };
}

// --- Save / Discard ---
btnSave.addEventListener('click', () => {
  const name = fieldName.value.trim();
  const price = fieldPrice.value.trim();
  if (!name && !price) { toast('Add a name or price first', 'error'); return; }
  saveRecord({ name, price });
  resultCard.classList.remove('visible');
  capturedBlob = null;
  previewImg.classList.add('hidden');
  scanPlaceholder.style.display = 'flex';
  renderRecords();
  toast('Saved!', 'success');
});

btnStripe.addEventListener('click', async () => {
  const name = fieldName.value.trim();
  const price = fieldPrice.value.trim();
  if (!name || !price) { toast('Name and price required', 'error'); return; }
  btnStripe.disabled = true;
  showStatus('Pushing to Stripe...');
  try {
    const ids = await pushToStripe({ name, price });
    const records = saveRecord({ name, price, stripeId: ids.productId, priceId: ids.priceId, sentToStripe: true });
    resultCard.classList.remove('visible');
    capturedBlob = null;
    previewImg.classList.add('hidden');
    scanPlaceholder.style.display = 'flex';
    renderRecords();
    hideStatus();
    toast('Saved + pushed to Stripe!', 'success');
  } catch (err) {
    hideStatus();
    toast('Stripe error: ' + err.message, 'error');
  } finally {
    btnStripe.disabled = false;
  }
});

btnDiscard.addEventListener('click', () => {
  resultCard.classList.remove('visible');
  capturedBlob = null;
  previewImg.classList.add('hidden');
  scanPlaceholder.style.display = 'flex';
});

// --- Records ---
function renderRecords() {
  const records = getRecords();
  if (!records.length) {
    recordsList.innerHTML = '<div class="empty-state">No records yet — scan a tag to get started.</div>';
    return;
  }
  recordsList.innerHTML = records.map(r => `
    <div class="record-item" data-id="${r.id}">
      <div class="record-info">
        <div class="record-name">${esc(r.name || '(no name)')}</div>
        <div class="record-meta">${new Date(r.createdAt).toLocaleDateString()} ${r.sentToStripe ? '· In Stripe' : ''}</div>
      </div>
      <div class="record-price">$${esc(r.price || '—')}</div>
      <div class="record-actions">
        ${!r.sentToStripe ? `<button class="record-btn push-stripe" data-id="${r.id}">→ Stripe</button>` : `<span class="record-btn stripe-sent">✓ Stripe</span>`}
        <button class="record-btn delete" data-id="${r.id}" title="Delete">✕</button>
      </div>
    </div>
  `).join('');
}

recordsList.addEventListener('click', async e => {
  const id = Number(e.target.dataset.id);
  if (!id) return;

  if (e.target.classList.contains('delete')) {
    deleteRecord(id);
    renderRecords();
    return;
  }

  if (e.target.classList.contains('push-stripe')) {
    const records = getRecords();
    const record = records.find(r => r.id === id);
    if (!record) return;
    e.target.disabled = true;
    e.target.textContent = '...';
    showStatus('Pushing to Stripe...');
    try {
      const ids = await pushToStripe(record);
      updateRecord(id, { stripeId: ids.productId, priceId: ids.priceId, sentToStripe: true });
      renderRecords();
      hideStatus();
      toast('Pushed to Stripe!', 'success');
    } catch (err) {
      hideStatus();
      toast('Stripe error: ' + err.message, 'error');
      e.target.disabled = false;
      e.target.textContent = '→ Stripe';
    }
  }
});

// --- Event listeners ---
btnCamera.addEventListener('click', () => {
  if (cameraActive) stopCamera();
  else startCamera();
});

btnCapture.addEventListener('click', captureFrame);
btnUpload.addEventListener('click', () => fileInput.click());
btnExport.addEventListener('click', () => { exportCSV(); toast('CSV downloaded', 'success'); });

// --- Helpers ---
function showStatus(msg) {
  statusMsg.textContent = msg;
  statusBar.classList.add('visible');
}
function hideStatus() { statusBar.classList.remove('visible'); }

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3000);
}

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- Init ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
renderRecords();
scanOverlay.style.display = 'none';
scanPlaceholder.style.display = 'flex';
video.classList.add('hidden');
