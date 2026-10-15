import {apiSizeForDimensions, apiUrl, fileStem, isPng, makeZip, parseRecords, uniqueFileName, validateDimension, validateFolderName} from './core.mjs';

const $ = id => document.getElementById(id);
const dataInput = $('data-input');
const folderInput = $('folder-name');
const widthInput = $('width-input');
const heightInput = $('height-input');
const chooseButton = $('choose-folder-button');
const generateButton = $('generate-button');
const cancelButton = $('cancel-button');
const supportsFolders = typeof window.showDirectoryPicker === 'function';
let parentFolder = null;
let running = false;
let cancelled = false;
let requestController = null;

function updateCount() {
  const count = parseRecords(dataInput.value).length;
  $('record-count').textContent = `${count} ${count === 1 ? 'record' : 'records'}`;
}

function showError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = false;
}

function clearError() {
  $('form-error').hidden = true;
  $('form-error').textContent = '';
}

function addLog(kind, message) {
  const list = $('activity-log');
  list.querySelector('.empty-log')?.remove();
  const item = document.createElement('li');
  item.className = `log-${kind}`;
  const icon = document.createElement('span');
  icon.className = 'log-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = kind === 'success' ? '✓' : kind === 'error' ? '!' : '·';
  const content = document.createElement('span');
  content.className = 'log-text';
  content.textContent = message;
  const time = document.createElement('time');
  time.className = 'log-time';
  time.textContent = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'});
  item.append(icon, content, time);
  list.append(item);
  list.scrollTop = list.scrollHeight;
}

function updateProgress(done, total, label) {
  $('progress-fill').style.width = total ? `${done / total * 100}%` : '0%';
  $('progress-count').textContent = `${done} / ${total}`;
  $('progress-text').textContent = label;
}

function setRunning(value) {
  running = value;
  generateButton.disabled = value;
  chooseButton.disabled = value || !supportsFolders;
  dataInput.disabled = value;
  folderInput.disabled = value;
  widthInput.disabled = value;
  heightInput.disabled = value;
  cancelButton.hidden = !value;
}

async function chooseFolder() {
  if (!supportsFolders || running) return;
  try {
    parentFolder = await window.showDirectoryPicker({mode: 'readwrite'});
    $('folder-description').textContent = parentFolder.name;
    $('location-help').textContent = `A new folder will be created inside “${parentFolder.name}”.`;
    clearError();
  } catch (error) {
    if (error.name !== 'AbortError') showError(`Could not open the folder: ${error.message}`);
  }
}

async function nameExists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch (error) {
    if (error.name === 'NotFoundError') return false;
    if (error.name === 'TypeMismatchError') return true;
    throw error;
  }
}

async function nextFileName(directory, stem, taken) {
  let name = uniqueFileName(stem, taken);
  if (!directory) return name;
  while (await nameExists(directory, name)) name = uniqueFileName(stem, taken);
  return name;
}

async function getPng(data, size) {
  requestController = new AbortController();
  const timeout = setTimeout(() => requestController.abort('timeout'), 30000);
  try {
    const response = await fetch(apiUrl(data, size), {signal: requestController.signal});
    if (!response.ok) throw new Error(`QR API returned ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!isPng(bytes)) throw new Error('QR API did not return a PNG image');
    return bytes;
  } catch (error) {
    if (cancelled) throw new Error('Cancelled');
    if (requestController.signal.aborted) throw new Error('Request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
    requestController = null;
  }
}

async function sizePng(bytes, width, height) {
  const image = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
  try {
    if (image.width === width && image.height === height) return bytes;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    if (canvas.width !== width || canvas.height !== height) throw new Error('These image dimensions are too large for this browser.');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('These image dimensions are too large for this browser.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = false;
    const side = Math.min(width, height);
    context.drawImage(image, Math.floor((width - side) / 2), Math.floor((height - side) / 2), side, side);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The browser could not create a PNG at these dimensions.');
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    image.close();
  }
}

async function savePng(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, {create: true});
  const stream = await handle.createWritable();
  try {
    await stream.write(bytes);
    await stream.close();
  } catch (error) {
    await stream.abort();
    throw error;
  }
}

function downloadZip(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function generate() {
  if (running) return;
  clearError();
  const records = parseRecords(dataInput.value);
  if (!records.length) return showError('Paste at least one line of data.');
  let folderName, width, height;
  try {
    folderName = validateFolderName(folderInput.value);
    width = validateDimension(widthInput.value, 'width');
    height = validateDimension(heightInput.value, 'height');
  } catch (error) {
    return showError(error.message);
  }
  if (supportsFolders && !parentFolder) {
    showError('Choose a location for your QR code folder.');
    return;
  }

  cancelled = false;
  setRunning(true);
  updateProgress(0, records.length, 'Preparing batch');
  let directory = null;
  const zipFiles = [];
  const taken = new Set();
  let success = 0, failed = 0, done = 0;
  try {
    if (supportsFolders) {
      directory = await parentFolder.getDirectoryHandle(folderName, {create: true});
      addLog('info', `Saving into ${parentFolder.name} / ${folderName}`);
    } else {
      addLog('info', `Preparing ${folderName}.zip for download`);
    }
    for (const record of records) {
      if (cancelled) break;
      const stem = fileStem(record);
      try {
        const name = await nextFileName(directory, stem, taken);
        updateProgress(done, records.length, `Creating ${name}`);
        addLog('info', `Creating ${name} · line ${record.lineNumber}`);
        const sourceBytes = await getPng(record.data, apiSizeForDimensions(width, height));
        const bytes = await sizePng(sourceBytes, width, height);
        if (cancelled) break;
        if (directory) await savePng(directory, name, bytes);
        else zipFiles.push({name, bytes});
        success++;
        addLog('success', `${name} created`);
      } catch (error) {
        if (cancelled) break;
        failed++;
        addLog('error', `Line ${record.lineNumber}: ${error.message}`);
      }
      done++;
      updateProgress(done, records.length, `${success} created${failed ? ` · ${failed} failed` : ''}`);
    }
    if (!directory && zipFiles.length) {
      const zip = makeZip(zipFiles, folderName);
      downloadZip(zip, folderName);
      addLog('success', `${folderName}.zip downloaded with ${zipFiles.length} PNGs`);
    }
    const ending = cancelled ? `Stopped · ${success} created` : `Complete · ${success} created${failed ? ` · ${failed} failed` : ''}`;
    updateProgress(done, records.length, ending);
    addLog(cancelled ? 'info' : 'success', ending);
  } catch (error) {
    showError(error.message);
    addLog('error', error.message);
  } finally {
    setRunning(false);
  }
}

if (!supportsFolders) {
  $('folder-description').textContent = 'ZIP download mode';
  $('location-help').textContent = 'This browser cannot select a folder. Your PNGs will download together as a ZIP.';
  chooseButton.disabled = true;
  generateButton.querySelector('span').textContent = 'Generate & download ZIP';
}

dataInput.addEventListener('input', updateCount);
chooseButton.addEventListener('click', chooseFolder);
generateButton.addEventListener('click', generate);
cancelButton.addEventListener('click', () => { cancelled = true; requestController?.abort(); });
$('sample-button').addEventListener('click', () => { dataInput.value = 'Pramod Mistry|US|GD/ASMD\nAnother Person|US|EXAMPLE'; updateCount(); dataInput.focus(); });
$('clear-log-button').addEventListener('click', () => { $('activity-log').innerHTML = '<li class="empty-log"><span class="empty-icon" aria-hidden="true">↗</span><span>Your generation activity will appear here, one QR code at a time.</span></li>'; });
updateCount();
