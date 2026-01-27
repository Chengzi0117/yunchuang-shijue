async function getEncryptionKey() {
    const password = 'CloudAI-Vision-Queue-2024-Secure-Key';
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(password);

    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveBits', 'deriveKey']
    );

    const salt = encoder.encode('CloudAI-Queue-Salt-2024');
    return await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: salt,
            iterations: 100000,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptData(data) {
    try {
        if (!data) return '';
        const encoder = new TextEncoder();
        const dataBuffer = encoder.encode(data);
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await getEncryptionKey();
        const encryptedBuffer = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            dataBuffer
        );
        const combined = new Uint8Array(iv.length + encryptedBuffer.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(encryptedBuffer), iv.length);
        return btoa(String.fromCharCode.apply(null, combined));
    } catch (e) {
        console.error('加密失败:', e);
        return '';
    }
}

async function decryptData(encryptedData) {
    try {
        if (!encryptedData) return '';
        const combined = new Uint8Array(
            atob(encryptedData).split('').map(c => c.charCodeAt(0))
        );
        const iv = combined.slice(0, 12);
        const data = combined.slice(12);
        const key = await getEncryptionKey();
        const decryptedBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            data
        );
        const decoder = new TextDecoder();
        return decoder.decode(decryptedBuffer);
    } catch (e) {
        console.error('解密失败:', e);
        return '';
    }
}

async function saveSecureConfig(key, value) {
    if (value) {
        const encrypted = await encryptData(value);
        localStorage.setItem('secure_' + key, encrypted);
    } else {
        localStorage.removeItem('secure_' + key);
    }
}

async function loadSecureConfig(key) {
    const encrypted = localStorage.getItem('secure_' + key);
    return encrypted ? await decryptData(encrypted) : '';
}

let productImages = [];
let referenceImages = [];
let taskQueue = [];
let isProcessing = false;
let currentTaskIndex = -1;

const apiEndpoint = document.getElementById('apiEndpoint');
const apiKey = document.getElementById('apiKey');
const modelName = document.getElementById('modelName');
const aspectRatio = document.getElementById('aspectRatio');
const concurrency = document.getElementById('concurrency');
const productInput = document.getElementById('productInput');
const referenceInput = document.getElementById('referenceInput');
const productUploadArea = document.getElementById('productUploadArea');
const referenceUploadArea = document.getElementById('referenceUploadArea');
const productPreview = document.getElementById('productPreview');
const referencePreview = document.getElementById('referencePreview');
const promptInput = document.getElementById('promptInput');
const addTaskBtn = document.getElementById('addTaskBtn');
const startQueueBtn = document.getElementById('startQueueBtn');
const pauseQueueBtn = document.getElementById('pauseQueueBtn');
const clearQueueBtn = document.getElementById('clearQueueBtn');
const taskList = document.getElementById('taskList');

window.addEventListener('DOMContentLoaded', async () => {
    let savedEndpoint = await loadSecureConfig('apiEndpoint');
    const savedKey = await loadSecureConfig('apiKey');
    const savedModel = await loadSecureConfig('modelName');

    if (savedEndpoint === 'http://154.36.173.51:3000') {
        savedEndpoint = '';
    }

    apiEndpoint.value = savedEndpoint || '/api/proxy';
    apiKey.value = savedKey || '';
    modelName.value = savedModel || 'gemini-3-pro-image-preview';

    checkAddTaskButton();
});

apiEndpoint.addEventListener('change', async () => {
    await saveSecureConfig('apiEndpoint', apiEndpoint.value);
});

apiKey.addEventListener('change', async () => {
    await saveSecureConfig('apiKey', apiKey.value);
});

modelName.addEventListener('change', async () => {
    await saveSecureConfig('modelName', modelName.value);
});

productInput.addEventListener('change', (e) => {
    handleFiles(Array.from(e.target.files), 'product');
});

productUploadArea.addEventListener('click', () => productInput.click());
productUploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    productUploadArea.style.borderColor = 'var(--primary-600)';
});
productUploadArea.addEventListener('dragleave', () => {
    productUploadArea.style.borderColor = 'var(--slate-300)';
});
productUploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    productUploadArea.style.borderColor = 'var(--slate-300)';
    handleFiles(Array.from(e.dataTransfer.files), 'product');
});

referenceInput.addEventListener('change', (e) => {
    handleFiles(Array.from(e.target.files), 'reference');
    referenceInput.value = '';
});

referenceFolderInput.addEventListener('change', (e) => {
    handleFiles(Array.from(e.target.files), 'reference');
    referenceFolderInput.value = '';
});

referenceUploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    referenceUploadArea.style.borderColor = 'var(--primary-600)';
});
referenceUploadArea.addEventListener('dragleave', () => {
    referenceUploadArea.style.borderColor = 'var(--slate-300)';
});
referenceUploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    referenceUploadArea.style.borderColor = 'var(--slate-300)';
    handleFiles(Array.from(e.dataTransfer.files), 'reference');
});

function handleFiles(files, type) {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    const targetArray = type === 'product' ? productImages : referenceImages;
    const previewElement = type === 'product' ? productPreview : referencePreview;
    const placeholderElement = type === 'product' ? document.getElementById('productPlaceholder') : document.getElementById('referencePlaceholder');

    imageFiles.forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
            targetArray.push({
                file: file,
                dataUrl: e.target.result,
                name: file.name
            });
            updatePreview(type);
            checkAddTaskButton();
        };
        reader.readAsDataURL(file);
    });
}

function updatePreview(type) {
    const targetArray = type === 'product' ? productImages : referenceImages;
    const previewElement = type === 'product' ? productPreview : referencePreview;
    const placeholderElement = type === 'product' ? document.getElementById('productPlaceholder') : document.getElementById('referencePlaceholder');

    previewElement.innerHTML = '';

    if (targetArray.length > 0) {
        placeholderElement.style.display = 'none';
        if (type === 'reference') {
            document.getElementById('referenceCountBadge').classList.add('active');
            document.getElementById('referenceCountBadge').textContent = `${targetArray.length} 张`;
            document.querySelector('#referenceUploadArea .btn-clear').classList.add('active');
        }
    } else {
        placeholderElement.style.display = 'flex';
        if (type === 'reference') {
            document.getElementById('referenceCountBadge').classList.remove('active');
            document.querySelector('#referenceUploadArea .btn-clear').classList.remove('active');
        }
    }

    targetArray.forEach((img, index) => {
        const div = document.createElement('div');
        div.className = 'preview-item';
        div.innerHTML = `
            <img src="${img.dataUrl}" alt="${type}${index + 1}">
            <button class="remove-btn" onclick="event.stopPropagation(); removeImage('${type}', ${index})">×</button>
        `;
        previewElement.appendChild(div);
    });
}

function removeImage(type, index) {
    const targetArray = type === 'product' ? productImages : referenceImages;
    targetArray.splice(index, 1);
    updatePreview(type);
    checkAddTaskButton();
}

function clearReferenceImages() {
    if (referenceImages.length === 0) {
        return;
    }
    referenceImages = [];
    updatePreview('reference');
    checkAddTaskButton();
}

function checkAddTaskButton() {
    const hasProduct = productImages.length > 0;
    const hasPrompt = promptInput.value.trim().length > 0;
    const hasApi = apiEndpoint.value.trim().length > 0 && apiKey.value.trim().length > 0;
    addTaskBtn.disabled = !(hasProduct && hasPrompt && hasApi);
}

promptInput.addEventListener('input', checkAddTaskButton);
apiEndpoint.addEventListener('input', checkAddTaskButton);
apiKey.addEventListener('input', checkAddTaskButton);

addTaskBtn.addEventListener('click', () => {
    const task = {
        id: Date.now(),
        name: `批次_${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`,
        productImages: productImages.map(img => ({
            dataUrl: img.dataUrl,
            name: img.name,
            mimeType: img.file.type
        })),
        referenceImages: referenceImages.map(img => ({
            dataUrl: img.dataUrl,
            name: img.name,
            mimeType: img.file.type
        })),
        prompt: promptInput.value.trim(),
        status: 'pending',
        progress: 0,
        results: [],
        createdAt: new Date().toISOString()
    };

    taskQueue.push(task);
    renderTaskList();
    updateStats();
    startQueueBtn.disabled = false;

    alert(`任务已添加! 产品图: ${productImages.length}张`);
});

function renderTaskList() {
    taskList.innerHTML = '';

    if (taskQueue.length === 0) {
        taskList.innerHTML = `
            <div class="empty-state">
                <svg class="empty-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path>
                </svg>
                <p>暂无任务,请添加任务到队列</p>
            </div>
        `;
        return;
    }

    taskQueue.forEach((task, index) => {
        const taskElement = document.createElement('div');
        taskElement.className = `task-item ${task.status}`;
        taskElement.innerHTML = `
            <div class="task-header">
                <div class="task-title">${task.name}</div>
                <div class="task-status ${task.status}">
                    ${getStatusText(task.status)}
                </div>
            </div>
            <div class="task-info">
                <span>🖼️ 产品图: ${task.productImages.length}张</span>
                <span>📝 参考图: ${task.referenceImages.length}张</span>
                <span>🕐 创建: ${new Date(task.createdAt).toLocaleTimeString()}</span>
            </div>
            ${task.status === 'processing' || task.status === 'completed' ? `
                <div class="task-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${task.progress}%"></div>
                    </div>
                    <div class="progress-text">${task.progress}% (${task.results.length}/${task.productImages.length})</div>
                </div>
            ` : ''}
            ${task.results.length > 0 ? `
                <div style="margin-bottom: 1rem; display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: 600; color: var(--slate-700);">生成结果 (${task.results.length}张)</div>
                    <button class="btn btn-success btn-sm" onclick="downloadAllAsZip(${index})" style="padding: 0.5rem 1rem;">
                        📦 打包下载ZIP
                    </button>
                </div>
                <div class="task-results">
                    ${task.results.map((result, i) => `
                        <div class="result-item">
                            <img src="${result.imageUrl}" alt="结果${i + 1}">
                            <div class="result-actions">
                                <button class="btn btn-primary btn-sm" onclick="downloadImage('${result.imageUrl}', '${result.originalFileName || task.name + '_' + (i + 1) + '.png'}')">下载</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            ` : ''}
        `;
        taskList.appendChild(taskElement);
    });
}

function getStatusText(status) {
    const statusMap = {
        pending: '⏳ 等待中',
        processing: '🔄 进行中',
        completed: '✅ 已完成',
        failed: '❌ 失败'
    };
    return statusMap[status] || status;
}

function updateStats() {
    document.getElementById('totalTasks').textContent = taskQueue.length;
    document.getElementById('pendingTasks').textContent = taskQueue.filter(t => t.status === 'pending').length;
    document.getElementById('processingTasks').textContent = taskQueue.filter(t => t.status === 'processing').length;
    document.getElementById('completedTasks').textContent = taskQueue.filter(t => t.status === 'completed').length;
    document.getElementById('failedTasks').textContent = taskQueue.filter(t => t.status === 'failed').length;
}

startQueueBtn.addEventListener('click', async () => {
    if (isProcessing) return;
    isProcessing = true;
    startQueueBtn.style.display = 'none';
    pauseQueueBtn.style.display = 'inline-flex';

    await processQueue();

    isProcessing = false;
    startQueueBtn.style.display = 'inline-flex';
    pauseQueueBtn.style.display = 'none';
});

pauseQueueBtn.addEventListener('click', () => {
    isProcessing = false;
    startQueueBtn.style.display = 'inline-flex';
    pauseQueueBtn.style.display = 'none';
});

clearQueueBtn.addEventListener('click', () => {
    if (confirm('确定要清空所有任务吗?')) {
        taskQueue = [];
        renderTaskList();
        updateStats();
        startQueueBtn.disabled = true;
    }
});

async function processQueue() {
    for (let i = 0; i < taskQueue.length; i++) {
        if (!isProcessing) break;

        const task = taskQueue[i];
        if (task.status !== 'pending') continue;

        task.status = 'processing';
        renderTaskList();
        updateStats();

        try {
            await processTask(task);
            task.status = 'completed';
        } catch (error) {
            console.error('任务失败:', error);
            task.status = 'failed';
        }

        renderTaskList();
        updateStats();
    }
}

function getTimeString() {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function processTask(task) {
    const endpoint = `${apiEndpoint.value.trim()}/v1beta/models/${modelName.value}:generate`;
    const maxConcurrent = parseInt(concurrency.value) || 3;

    task.results = [];

    const allGenerationTasks = [];

    task.productImages.forEach((productImg, productIndex) => {
        if (task.referenceImages.length > 0) {
            task.referenceImages.forEach((refImg, refIndex) => {
                allGenerationTasks.push({
                    productImg,
                    productIndex,
                    refImg,
                    refIndex
                });
            });
        } else {
            allGenerationTasks.push({
                productImg,
                productIndex,
                refImg: null,
                refIndex: -1
            });
        }
    });

    const totalTasks = allGenerationTasks.length;
    const startTime = Date.now();
    const startTimeStr = getTimeString();

    console.log(`\n┌─────────────────────────────────────────────────────`);
    console.log(`│ 📋 开始处理任务: ${task.name}`);
    console.log(`│ 🕐 开始时间: ${startTimeStr}`);
    console.log(`│ 📊 总共需要生成: ${totalTasks} 张图片`);
    console.log(`│ ⚙️  并发设置: 每批 ${maxConcurrent} 个`);
    console.log(`└─────────────────────────────────────────────────────\n`);

    for (let i = 0; i < totalTasks; i += maxConcurrent) {
        const batch = allGenerationTasks.slice(i, i + maxConcurrent);
        const batchNum = Math.floor(i / maxConcurrent) + 1;
        console.log(`🚀 [${getTimeString()}] 开始第 ${batchNum} 批，并发调用 ${batch.length} 个API...\n`);

        const promises = batch.map((taskItem, batchIndex) => {
            const taskNum = i + batchIndex + 1;
            return generateSingleImage(task, taskItem, endpoint, taskNum, totalTasks);
        });

        const results = await Promise.all(promises);
        task.results.push(...results);

        task.progress = Math.round((task.results.length / totalTasks) * 100);
        console.log(`\n✅ [${getTimeString()}] 第 ${batchNum} 批完成，当前进度: ${task.progress}% (${task.results.length}/${totalTasks})\n`);
        renderTaskList();
    }

    const endTime = Date.now();
    const endTimeStr = getTimeString();
    const totalSeconds = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`┌─────────────────────────────────────────────────────`);
    console.log(`│ 🎉 任务完成！`);
    console.log(`│ 🕐 开始时间: ${startTimeStr}`);
    console.log(`│ 🕐 结束时间: ${endTimeStr}`);
    console.log(`│ ⏱️  总耗时: ${totalSeconds} 秒`);
    console.log(`│ 📊 生成图片: ${task.results.length} 张`);
    console.log(`│ ⚡ 平均速度: ${(totalSeconds / task.results.length).toFixed(2)} 秒/张`);
    console.log(`└─────────────────────────────────────────────────────\n`);
}

async function generateSingleImage(task, taskItem, endpoint, taskNum, totalTasks) {
    const { productImg, productIndex, refImg, refIndex } = taskItem;

    let finalPrompt = task.prompt;
    if (refImg) {
        finalPrompt += ` - 产品图${productIndex + 1}: ${productImg.name}, 参考图${refIndex + 1}`;
    } else {
        finalPrompt += ` - 产品图${productIndex + 1}: ${productImg.name}`;
    }

    const productImageBase64 = productImg.dataUrl.split(',')[1];

    const requestBody = {
        contents: [{
            parts: [{
                text: finalPrompt
            }, {
                inline_data: {
                    mime_type: productImg.mimeType,
                    data: productImageBase64
                }
            }]
        }],
        generationConfig: {
            aspectRatio: aspectRatio.value
        }
    };

    if (refImg) {
        requestBody.contents[0].parts.push({
            inline_data: {
                mime_type: refImg.mimeType,
                data: refImg.dataUrl.split(',')[1]
            }
        });
    }

    const apiStartTime = Date.now();
    console.log(`📤 [${getTimeString()}] API请求 ${taskNum}/${totalTasks}:`, {
        endpoint: endpoint,
        model: modelName.value,
        aspectRatio: aspectRatio.value,
        prompt: finalPrompt.substring(0, 100) + '...',
        productImage: productImg.name,
        referenceImage: refImg ? `参考图${refIndex + 1}` : '无'
    });

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey.value.trim()}`
        },
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey.value.trim()}`
        },
        body: JSON.stringify(requestBody)
    });

    const apiEndTime = Date.now();
    const apiDuration = ((apiEndTime - apiStartTime) / 1000).toFixed(2);

    console.log(`📥 [${getTimeString()}] API响应 ${taskNum}/${totalTasks}: ${response.status} ${response.statusText} (耗时: ${apiDuration}秒)`);

    const responseText = await response.text();
    console.log(`📄 API响应内容 ${taskNum}/${totalTasks}:`, responseText.substring(0, 500));

    if (!response.ok) {
        throw new Error(`图片${taskNum} API请求失败 (${response.status})\n响应: ${responseText.substring(0, 200)}`);
    }

    let data;
    try {
        data = JSON.parse(responseText);
    } catch (e) {
        throw new Error(`图片${taskNum} 无法解析API响应为JSON`);
    }

    if (data.promptFeedback && data.promptFeedback.blockReason) {
        const blockReason = data.promptFeedback.blockReason;
        throw new Error(`图片${taskNum} 生成被阻止: ${blockReason}。建议更换图片或简化提示词`);
    }

    if (data.candidates && data.candidates[0]?.content?.parts) {
        const parts = data.candidates[0].content.parts;
        const imagePart = parts.find(part => part.inlineData || part.inline_data);
        if (imagePart) {
            const imageData = imagePart.inlineData || imagePart.inline_data;
            const mimeType = imageData.mimeType || imageData.mime_type || 'image/png';
            const totalDuration = ((Date.now() - apiStartTime) / 1000).toFixed(2);
            console.log(`✅ [${getTimeString()}] 图片${taskNum} 生成成功！MIME类型: ${mimeType}, 总耗时: ${totalDuration}秒`);
            return {
                imageUrl: `data:${mimeType};base64,${imageData.data}`,
                productName: productImg.name,
                originalFileName: refImg ? refImg.name : productImg.name
            };
        }
    }

    console.error(`❌ 无法提取图片${taskNum}的数据，完整响应:`, data);
    throw new Error(`无法提取图片${taskNum}数据`);
}

function downloadImage(url, filename) {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

async function downloadAllAsZip(taskIndex) {
    const task = taskQueue[taskIndex];
    if (!task || !task.results || task.results.length === 0) {
        alert('没有可下载的图片');
        return;
    }

    try {
        const zip = new JSZip();
        const folder = zip.folder(task.name);

        for (let i = 0; i < task.results.length; i++) {
            const result = task.results[i];
            const imageUrl = result.imageUrl;

            const base64Data = imageUrl.split(',')[1];

            const filename = `${i + 1}.png`;

            folder.file(filename, base64Data, { base64: true });
        }

        console.log(`📦 正在打包 ${task.results.length} 张图片...`);
        const content = await zip.generateAsync({
            type: 'blob',
            compression: 'DEFLATE',
            compressionOptions: { level: 6 }
        });

        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = `${task.name}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);

        console.log(`✅ ZIP文件已生成: ${task.name}.zip`);
    } catch (error) {
        console.error('打包失败:', error);
        alert('打包下载失败: ' + error.message);
    }
}
