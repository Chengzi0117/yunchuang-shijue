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
const referenceFolderInput = document.getElementById('referenceFolderInput');
const productUploadArea = document.getElementById('productUploadArea');
const referenceUploadArea = document.getElementById('referenceUploadArea');
const productPreview = document.getElementById('productPreview');
const referencePreview = document.getElementById('referencePreview');
const promptInput = document.getElementById('promptInput');
const addTaskBtn = document.getElementById('addTaskBtn');
const startQueueBtn = document.getElementById('startQueueBtn');
const pauseQueueBtn = document.getElementById('pauseQueueBtn');
const clearQueueBtn = document.getElementById('clearQueueBtn');
// 接口择优管理器
const endpointManager = {
    list: ['/api/proxy3', '/api/proxy4', '/api/proxy5'],
    sortedList: [],
    best: '/api/proxy3',
    isLocked: false,

    async probe() {
        if (this.isLocked) return;
        const key = apiKey.value.trim();
        console.log('🔍 开始 3 端口全量性能检测...');
        const results = await Promise.all(this.list.map(async (url) => {
            const start = Date.now();
            try {
                // 采用双重 Header 兼容方案防止 403
                const headers = {};
                if (key) {
                    headers['Authorization'] = `Bearer ${key}`;
                    headers['x-goog-api-key'] = key;
                }

                const resp = await fetch(`${url}/v1beta/models`, {
                    method: 'GET',
                    priority: 'high',
                    headers: headers
                });
                return { url, latency: resp.ok ? Date.now() - start : 5000 };
            } catch (e) {
                return { url, latency: 9999 };
            }
        }));
        results.sort((a, b) => a.latency - b.latency);
        this.sortedList = results.map(r => r.url);
        this.best = this.sortedList[0];
        this.isProbed = true; // 锁定标志位避免重复探测
        console.log('🚀 竞速排名:', results.map(r => `${r.url}(${r.latency}ms)`).join(' > '));
        return results;
    },

    getNext(currentUrl) {
        if (this.isLocked) this.isLocked = false;
        const list = this.sortedList.length > 0 ? this.sortedList : this.list;
        const currentIndex = list.indexOf(currentUrl);
        const nextUrl = list[currentIndex + 1] || list[0];
        console.warn(`⚠️ 故障切换: ${currentUrl} -> ${nextUrl}`);
        return nextUrl;
    },

    lock(url) {
        if (!this.isLocked) {
            this.best = url;
            this.isLocked = true;
            console.log(`✅ 已锁定接口: ${url}`);
        }
    }
};

const taskList = document.getElementById('taskList');

// IndexedDB 管理器 - 解决 localStorage 5MB 限制问题
const dbManager = {
    dbName: 'CloudAI_Vision_DB',
    version: 1,
    storeName: 'tasks',
    db: null,

    async init() {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.version);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: 'id' });
                }
            };
        });
    },

    async saveTasks(tasks) {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const clearReq = store.clear();
            clearReq.onsuccess = () => {
                if (tasks.length === 0) {
                    resolve();
                    return;
                }
                let count = 0;
                tasks.forEach(task => {
                    const addReq = store.add(task);
                    addReq.onsuccess = () => {
                        count++;
                        if (count === tasks.length) resolve();
                    };
                    addReq.onerror = () => reject(addReq.error);
                });
            };
            clearReq.onerror = () => reject(clearReq.error);
        });
    },

    async loadTasks() {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readonly');
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    },

    async clearTasks() {
        await this.init();
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
};

// 模型管理器
const modelManager = {
    list: [
        '「XXQ」gemini-3-pro-image-preview',
        '「ZX」gemini-3-pro-image-preview',
        '「YU」gemini-3-pro-image-preview',
        '「YS」gemini-3-pro-image-preview',
        '「Rim」gemini-3-pro-image-preview',
        '「QM」gemini-3-pro-image-preview',
        '「YQ」gemini-3-pro-image-preview',
        '「CS」gemini-3-pro-image-preview',
        'gemini-3-pro-image-preview'
    ],
    current: '「XXQ」gemini-3-pro-image-preview', // 默认第一个
    working: null, // 锁定的可用模型

    async probe(endpoint) {
        if (this.working) return this.working;

        console.log('🤖 开始模型可用性自检...');
        const key = apiKey.value.trim();
        if (!key) return this.current;

        // 顺序检测，找到第一个可用的即可
        for (const model of this.list) {
            console.log(`Trying model: ${model}...`);
            try {
                const resp = await fetch(`${endpoint}/v1beta/models/${model}:generateContent`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`,
                        'x-goog-api-key': key
                    },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: "Hi" }] }],
                        generationConfig: { maxOutputTokens: 1 }
                    })
                });

                if (resp.ok) {
                    console.log(`✅ 模型可用: ${model}`);
                    this.working = model;
                    this.current = model;
                    if (modelName) modelName.value = model;
                    await saveSecureConfig('modelName', model);
                    return model;
                } else {
                    console.warn(`⚠️ 模型不可用: ${model} (${resp.status})`);
                }
            } catch (e) {
                console.error(`❌ 模型检测出错: ${model}`, e);
            }
        }

        console.error('⚠️ 所有模型检测均未通过，重置为默认');
        this.working = this.list[0];
        this.current = this.list[0];
        return this.list[0];
    },

    getNext(currentModel) {
        const idx = this.list.indexOf(currentModel);
        if (idx === -1 || idx === this.list.length - 1) {
            return this.list[0];
        }
        return this.list[idx + 1];
    },

    lock(model) {
        this.working = model;
        this.current = model;
        saveSecureConfig('modelName', model);
        console.log(`🔒 锁定优选模型: ${model}`);
    }
};

window.addEventListener('DOMContentLoaded', async () => {
    const savedKey = await loadSecureConfig('apiKey');
    // 不要直接加载 savedModel，因为我们要重新自检，除非用户希望保持上次的
    // 根据需求："自动进行api端口和模型测试"，所以每次刷新应该重新测？
    // 或者只在没有 savedModel 时测？需求说 "打开网页的时候，自动...测试"
    // 所以倾向于每次都跑一遍确保最佳，或者至少验证当前的是否还ok

    apiEndpoint.value = '/api/proxy';
    apiKey.value = savedKey || '';

    // 初始化 UI
    modelName.innerHTML = modelManager.list.map(m => `<option value="${m}">${m}</option>`).join('');
    modelName.value = modelManager.current;

    await loadQueueFromStorage();
    checkAddTaskButton();

    // 自动全链路测速
    if (apiKey.value.trim()) {
        try {
            // 1. 测端口
            const results = await endpointManager.probe();
            const bestEndpoint = endpointManager.best;

            // 2. 测模型 (在最佳端口上)
            await modelManager.probe(bestEndpoint);

            // 显示结果到隐藏的 div? 或者只是 console
            console.log(`🏁 优选方案已就绪: ENDPOINT=[${bestEndpoint}] MODEL=[${modelManager.current}]`);

        } catch (e) {
            console.error('自动初始化失败', e);
        }
    }
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
        div.className = 'preview-item thumb-wrapper';
        div.innerHTML = `
            <img src="${img.dataUrl}" alt="${type}${index + 1}" class="mini-img" 
                 onmouseenter="showGlobalPreview(event, '${img.dataUrl}')" 
                 onmousemove="moveGlobalPreview(event)"
                 onmouseleave="hideGlobalPreview()">
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
        prompt: (() => {
            let p = promptInput.value.trim();
            p += `, 图片比例 ${aspectRatio.value}`;
            if (!p.includes('4K高清画质')) {
                p += ', 4K高清画质';
            }
            return p;
        })(),
        modelName: modelName.value,
        aspectRatio: aspectRatio.value,
        status: 'pending',
        progress: 0,
        results: [],
        createdAt: new Date().toISOString()
    };

    taskQueue.push(task);
    saveQueueToStorage();
    renderTaskList();
    updateStats();
    startQueueBtn.disabled = false;
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
            <div class="task-main-row">
                <div class="task-left-info">
                    <div class="task-title-bar">
                        <div class="task-title">${task.name}</div>
                        <div class="task-status ${task.status}">${getStatusText(task.status)}</div>
                    </div>
                    <div class="task-stats-bar">
                        <span>🖼️ 产品图: ${task.productImages.length}张</span>
                        <span>📝 参考图: ${task.referenceImages.length}张</span>
                        <span>🕐 创建: ${new Date(task.createdAt).toLocaleTimeString()}</span>
                    </div>
                </div>

                <div class="task-middle-preview">
                    <div class="inline-preview-section">
                        <div class="preview-tag">产品图</div>
                        <div class="mini-thumb-list">
                            ${task.productImages.slice(0, 10).map(img => `
                                <div class="thumb-wrapper">
                                    <img src="${img.dataUrl}" class="mini-img" 
                                         onmouseenter="showGlobalPreview(event, '${img.dataUrl}')" 
                                         onmousemove="moveGlobalPreview(event)"
                                         onmouseleave="hideGlobalPreview()">
                                </div>
                            `).join('')}
                            ${task.productImages.length > 10 ? `<span class="more-indicator">+${task.productImages.length - 10}</span>` : ''}
                        </div>
                    </div>
                    ${task.referenceImages.length > 0 ? `
                    <div class="inline-preview-section">
                        <div class="preview-tag">参考图</div>
                        <div class="mini-thumb-list">
                            ${task.referenceImages.slice(0, 10).map(img => `
                                <div class="thumb-wrapper">
                                    <img src="${img.dataUrl}" class="mini-img" 
                                         onmouseenter="showGlobalPreview(event, '${img.dataUrl}')" 
                                         onmousemove="moveGlobalPreview(event)"
                                         onmouseleave="hideGlobalPreview()">
                                </div>
                            `).join('')}
                            ${task.referenceImages.length > 10 ? `<span class="more-indicator">+${task.referenceImages.length - 10}</span>` : ''}
                        </div>
                    </div>
                    ` : ''}
                    <div class="inline-preview-section prompt-section" title="${task.status === 'pending' ? '点击可修改提示词' : task.prompt}">
                        <div class="preview-tag">提示词 ${task.status === 'pending' ? '✍️' : ''}</div>
                        <div class="mini-prompt-text ${task.status === 'pending' ? 'editable' : ''}" 
                             ${task.status === 'pending' ? `contenteditable="true" onblur="updateTaskPrompt(${index}, this.innerText)"` : ''}>${task.prompt}</div>
                    </div>
                </div>

                <div class="task-right-actions">
                    <button class="btn-delete-task" onclick="removeTask(${index})" title="删除任务">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
            ${task.status === 'processing' || task.status === 'completed' ? `
                <div class="task-progress">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${task.progress}%"></div>
                    </div>
                    <div class="progress-text">${task.progress}% (${task.results.length}/${task.productImages.length})</div>
                </div>
            ` : ''
            }
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
            ` : ''
            }
        `;
        taskList.appendChild(taskElement);
    });
}

function removeTask(index) {
    taskQueue.splice(index, 1);
    saveQueueToStorage();
    renderTaskList();
    updateStats();
    if (taskQueue.length === 0) {
        startQueueBtn.disabled = true;
    }
}

function updateTaskPrompt(index, newPrompt) {
    if (taskQueue[index]) {
        let cleanedPrompt = newPrompt.trim();
        // 自动补齐4K后缀逻辑
        if (!cleanedPrompt.includes('4K高清画质')) {
            cleanedPrompt += ', 4K高清画质';
        }
        taskQueue[index].prompt = cleanedPrompt;
        saveQueueToStorage();
        // 更新视图以反映可能的后缀添加
        renderTaskList();
        console.log(`Task ${index} prompt updated and saved`);
    }
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

    // 仅在未测速或Key刷新时运行
    if (!endpointManager.isProbed || !endpointManager.best) {
        console.log('⏳ 首次运行或通道失效，正在初始化...');
        await endpointManager.probe();
        await modelManager.probe(endpointManager.best);
    }

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

clearQueueBtn.addEventListener('click', async () => {
    if (confirm('确定要清空所有任务吗?')) {
        taskQueue = [];
        await dbManager.clearTasks();
        renderTaskList();
        updateStats();
        startQueueBtn.disabled = true;

    }
});

// 新增测速按钮逻辑 (已废弃，改为自动执行)
const speedTestBtn = document.getElementById('speedTestBtn');
const speedTestResult = document.getElementById('speedTestResult');

// 自动测速逻辑移至 DOMContentLoaded


// 辅助函数：为了能在 UI 显示具体的延迟，我们可以稍微 hack 一下或者这就够了
// 考虑到 probe 函数在前面定义了，我们也可以去修改 endpointManager.probe 让它返回 results


async function processQueue() {
    console.log('📡 队列监听已开启...');
    while (isProcessing) {
        // 查找队列中第一个等待中的任务
        const taskIndex = taskQueue.findIndex(t => t.status === 'pending');

        if (taskIndex === -1) {
            // 暂时没有待处理任务，微调休眠时间，进入后台监听模式
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }

        const task = taskQueue[taskIndex];
        task.status = 'processing';
        renderTaskList();
        updateStats();

        try {
            await processTask(task);
            if (task.results.length === 0 && task.productImages.length > 0) {
                task.status = 'failed';
            } else {
                task.status = 'completed';
                task.progress = 100;
            }
        } catch (error) {
            console.error('任务处理过程发生严重错误:', error);
            task.status = 'failed';
        }

        saveQueueToStorage();
        renderTaskList();
        updateStats();
    }
    console.log('🛑 队列已暂停/结束');
}

function getTimeString() {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

async function processTask(task) {
    // 动态获取当前优选模型
    const getEndpoint = (baseUrl, modelOverride) =>
        `${baseUrl}/v1beta/models/${modelOverride || modelManager.current}:generateContent`;
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
    console.log(`│ 📋 开始处理任务: ${task.name} `);
    console.log(`│ 🕐 开始时间: ${startTimeStr} `);
    console.log(`│ 📊 总共需要生成: ${totalTasks} 张图片`);
    console.log(`│ ⚙️  并发设置: 每批 ${maxConcurrent} 个`);
    console.log(`└─────────────────────────────────────────────────────\n`);

    for (let i = 0; i < totalTasks; i += maxConcurrent) {
        const batch = allGenerationTasks.slice(i, i + maxConcurrent);
        const batchNum = Math.floor(i / maxConcurrent) + 1;
        console.log(`🚀[${getTimeString()}] 开始第 ${batchNum} 批，并发调用 ${batch.length} 个API...\n`);

        const batchPromises = batch.map((taskItem, batchIndex) => {
            const taskNum = i + batchIndex + 1;
            // 初始使用检测出的最优接口（或已锁定的接口）
            return generateSingleImage(task, taskItem, endpointManager.best, taskNum, totalTasks, getEndpoint)
                .then(res => ({ success: true, data: res }))
                .catch(err => ({ success: false, error: err.message }));
        });

        const batchResults = await Promise.all(batchPromises);

        batchResults.forEach(res => {
            if (res.success) {
                task.results.push(res.data);
            } else {
                console.error(`❌ 该图片生成失败: ${res.error}`);
            }
        });

        task.progress = Math.round(((i + batch.length) / totalTasks) * 100);
        console.log(`\n✅[${getTimeString()}] 第 ${batchNum} 批处理完毕，当前成功: ${task.results.length} / ${i + batch.length} \n`);
        renderTaskList();
        saveQueueToStorage(); // 每一批次完成后保存进度
    }

    const endTime = Date.now();
    const endTimeStr = getTimeString();
    const totalSeconds = ((endTime - startTime) / 1000).toFixed(2);

    console.log(`┌─────────────────────────────────────────────────────`);
    console.log(`│ 🎉 任务完成！`);
    console.log(`│ 🕐 开始时间: ${startTimeStr} `);
    console.log(`│ 🕐 结束时间: ${endTimeStr} `);
    console.log(`│ ⏱️  总耗时: ${totalSeconds} 秒`);
    console.log(`│ 📊 生成图片: ${task.results.length} 张`);
    console.log(`│ ⚡ 平均速度: ${(totalSeconds / task.results.length).toFixed(2)} 秒 / 张`);
    console.log(`└─────────────────────────────────────────────────────\n`);
}

async function generateSingleImage(task, taskItem, currentBaseUrl, taskNum, totalTasks, getEndpointFn) {
    const { productImg, productIndex, refImg, refIndex } = taskItem;
    const maxRetries = 3;
    let retryCount = 0;

    // 初始参数
    let activeBaseUrl = currentBaseUrl; // 允许在重试中动态切换
    let activeModel = modelManager.current;

    // --- 提示词增强逻辑开始 ---
    let finalPrompt = task.prompt;

    // 注入引用标签
    if (refImg) {
        finalPrompt += ` | Reference: Product[${productImg.name}], Style[${refImg.name}]`;
    } else {
        finalPrompt += ` | Reference: Product[${productImg.name}]`;
    }

    // 注入最高权重画质标签（放在提示词末尾）
    const qualitySuffix = ` | (4K resolution, ultra-high definition, 8K UHD, masterpiece, highly detailed:1.2), 4K高清画质, 图片比例 ${task.aspectRatio || aspectRatio.value}`;
    finalPrompt += qualitySuffix;

    console.log(`📝[${getTimeString()}] 最终下发提示词: ${finalPrompt}`);
    // --- 提示词增强逻辑结束 ---

    const productImageBase64 = productImg.dataUrl.split(',')[1];

    // 预组装 Body
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
            aspectRatio: task.aspectRatio || aspectRatio.value
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

    while (retryCount <= maxRetries) {
        try {
            const fullApiUrl = getEndpointFn(activeBaseUrl, activeModel);
            const apiStartTime = Date.now();

            console.log(`📤[${getTimeString()}] 请求 ${taskNum}/${totalTasks} | 端口:${activeBaseUrl.slice(-7)} | 模型:${activeModel}`);

            const response = await fetch(fullApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey.value.trim()}`,
                    'x-goog-api-key': apiKey.value.trim()
                },
                body: JSON.stringify(requestBody)
            });

            const apiEndTime = Date.now();
            const apiDuration = ((apiEndTime - apiStartTime) / 1000).toFixed(2);

            if (!response.ok) {
                const responseText = await response.text();
                console.warn(`📥 失败 ${response.status}: ${responseText.slice(0, 100)}...`);

                // 核心重试策略
                retryCount++;

                // 1. 优先切换模型
                const nextModel = modelManager.getNext(activeModel);
                console.warn(`⚠️ 模型 ${activeModel} 异常，切换至 -> ${nextModel} 重试 (${retryCount}/${maxRetries})`);
                activeModel = nextModel;

                // 2. 偶数次尝试切换端口
                if (retryCount % 2 === 0) {
                    activeBaseUrl = endpointManager.getNext(activeBaseUrl);
                    console.warn(`⚠️ 同时切换端口至 -> ${activeBaseUrl}`);
                }

                const delay = 1000 * retryCount;
                await new Promise(r => setTimeout(r, delay));
                continue; // 重新进入循环
            }

            // --- 成功逻辑 ---
            const responseText = await response.text();
            console.log(`✅ 成功! 耗时:${apiDuration}s`);

            // 锁定成功的模型和端口
            if (activeModel !== modelManager.current) {
                modelManager.lock(activeModel);
            }
            if (activeBaseUrl !== endpointManager.best) {
                endpointManager.lock(activeBaseUrl);
            }

            let data;
            try {
                data = JSON.parse(responseText);
            } catch (e) {
                throw new Error(`图片${taskNum} 无法解析API响应为JSON`);
            }

            if (data.promptFeedback && data.promptFeedback.blockReason) {
                throw new Error(`图片${taskNum} 生成由于安全策略被拦截: ${data.promptFeedback.blockReason}`);
            }

            if (data.candidates && data.candidates[0]?.content?.parts) {
                const parts = data.candidates[0].content.parts;
                const imagePart = parts.find(part => part.inlineData || part.inline_data);
                if (imagePart) {
                    const imageData = imagePart.inlineData || imagePart.inline_data;
                    const mimeType = imageData.mimeType || imageData.mime_type || 'image/png';
                    return {
                        imageUrl: `data:${mimeType};base64,${imageData.data}`,
                        productName: productImg.name,
                        originalFileName: refImg ? refImg.name : productImg.name
                    };
                }
            }

            throw new Error(`无法从响应中提取图片数据: ${responseText.substring(0, 100)}...`);

        } catch (error) {
            // 网络级错误（非HTTP响应错误）处理
            if (retryCount < maxRetries && (error.message.includes('fetch') || error.message.includes('Network'))) {
                retryCount++;
                activeBaseUrl = endpointManager.getNext(activeBaseUrl);
                console.warn(`⚠️ 网络连接失败，切换至 ${activeBaseUrl} 重试...`);
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            throw error; // 无法重试的错误，抛出
        }
    }
    throw new Error(`图片${taskNum} 重试次数耗尽，生成失败`);
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

// 全局预览功能
function showGlobalPreview(event, imageUrl) {
    const preview = document.getElementById('globalImagePreview');
    preview.innerHTML = `<img src="${imageUrl}">`;
    preview.style.display = 'block';
    moveGlobalPreview(event);
}

function moveGlobalPreview(event) {
    const preview = document.getElementById('globalImagePreview');
    const padding = 20;
    let x = event.clientX + padding;
    let y = event.clientY - 160; // 居中于鼠标

    // 防止超出右边界
    if (x + 340 > window.innerWidth) {
        x = event.clientX - 340 - padding;
    }
    // 防止超出上下边界
    if (y < 10) y = 10;
    if (y + 340 > window.innerHeight) {
        y = window.innerHeight - 340 - 10;
    }

    preview.style.left = x + 'px';
    preview.style.top = y + 'px';
}

function hideGlobalPreview() {
    const preview = document.getElementById('globalImagePreview');
    preview.style.display = 'none';
}

// 队列持久化功能 - 使用 IndexedDB 替代 localStorage
async function saveQueueToStorage() {
    try {
        await dbManager.saveTasks(taskQueue);
    } catch (e) {
        console.error('任务队列同步到数据库失败:', e);
    }
}

async function loadQueueFromStorage() {
    try {
        const savedTasks = await dbManager.loadTasks();
        if (savedTasks && savedTasks.length > 0) {
            taskQueue = savedTasks;
            // 恢复后如果是进行中，重置为等待中，因为进程已中断
            taskQueue.forEach(t => {
                if (t.status === 'processing') t.status = 'pending';
            });
            renderTaskList();
            updateStats();
            if (taskQueue.length > 0) startQueueBtn.disabled = false;
        }
    } catch (e) {
        console.error('从数据库恢复任务队列失败:', e);
    }
}
