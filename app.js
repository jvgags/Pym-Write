/* ========== PYM WRITE APP.JS - DOCUMENT-BASED VERSION ========== */

// Global Variables
let projects = [];
let documents = [];
let settings = {
    theme: 'default',
    fontSize: 16,
    autoSaveInterval: 60000,
    lastProjectId: null,
    lastDocumentId: null,
    favoriteModels: [],
    customSystemPrompt: null,
    customUserPrompt: null,
    lastUsedModel: 'anthropic/claude-3.5-sonnet',
    lastTemperature: 0.7,
    lastTokenCount: 2048
};

let currentProjectId = null;
let currentDocumentId = null;
let autoSaveTimer = null;
let hasUnsavedChanges = false;
let lastAiResponse = '';
let quillEditor = null;
let draggedElement = null;

let apiKey = localStorage.getItem('openrouterApiKey');

// OpenRouter Models List - will be populated from API
let OPENROUTER_MODELS = [];
let modelsLoaded = false;

// IndexedDB Setup
const DB_NAME = 'AINovelWriterDB';
const DB_VERSION = 3;
const STORE_NAME = 'data';
let db;

// 1. Import the Block Embed
const BlockEmbed = Quill.import('blots/block/embed');

// 2. Create the Divider Class
class DividerBlot extends BlockEmbed {}
DividerBlot.blotName = 'divider'; // The name we use to insert it
DividerBlot.tagName = 'hr';       // The HTML tag it corresponds to

// 3. Register it with Quill
Quill.register(DividerBlot);

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (e) => {
            db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };

        request.onsuccess = (e) => {
            db = e.target.result;
            resolve(db);
        };

        request.onerror = (e) => {
            console.error('IndexedDB error:', e.target.error);
            showToast('Database error. Data may not save.');
            reject(e);
        };
    });
}

async function saveToDB(id, data) {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({ id, value: data });
        tx.oncomplete = () => resolve();
        tx.onerror = (e) => reject(e);
    });
}

async function loadFromDB(id) {
    if (!db) await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).get(id);
        request.onsuccess = () => resolve(request.result ? request.result.value : null);
        request.onerror = (e) => reject(e);
    });
}

/* ========== INITIALIZATION ========== */

window.onload = async function() {
    try {
        await openDB();
        await loadData();
    } catch (e) {
        showToast('Failed to open database.');
    }

    // Initialize Quill Editor
    quillEditor = new Quill('#editor', {
        theme: 'snow',
        placeholder: 'Select a document from the sidebar to start writing...',
        modules: {
            toolbar: [
                [{ 'header': [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                [{ 'indent': '-1'}, { 'indent': '+1' }],
                ['blockquote', 'code-block'],
                [{ 'align': [] }],
                ['clean']
            ]
        }
    });

    // Quill change listener
    quillEditor.on('text-change', () => {
        hasUnsavedChanges = true;
        updateWordCount();
        resetAutoSaveTimer();
    });

        // Floating Continue button + Tab shortcut
    quillEditor.on('selection-change', (range) => {
        if (range) updateFloatingContinueButton();
    });

    quillEditor.on('text-change', () => {
        hasUnsavedChanges = true;
        updateWordCount();
        resetAutoSaveTimer();
        // Re-check button visibility after typing
        setTimeout(updateFloatingContinueButton, 100);
    });

    // Tab key = Continue from cursor (best pro workflow)
    quillEditor.keyboard.addBinding({
        key: 'Tab',
        handler: function(range, context) {
            if (range.index > 40) {
                continueFromCursor();
                return false; // prevent actual tab
            }
        }
    });

    // Optional: Ctrl+Enter also continues
    quillEditor.keyboard.addBinding({
        key: 'Enter',
        ctrlKey: true,
        handler: function() {
            continueFromCursor();
            return false;
        }
    });

    // Hide floating button when clicking elsewhere
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#floatingContinueBtn') && !e.target.closest('.ql-editor')) {
            hideFloatingContinueButton();
        }
    });

    // Check API key
    if (!apiKey || apiKey === 'null') {
        if (apiKey === 'null') {
            localStorage.removeItem('openrouterApiKey');
            apiKey = null;
        }
        document.getElementById('apiKeyModal').style.display = 'flex';
        document.getElementById('apiKeyInput').focus();
    }

    // Update UI
    updateProjectsList();
    updateProjectDropdown();
    updateDocumentsList();
    updateWordCount();
    await fetchOpenRouterModels();
    populateModelSelect();

    // Restore saved AI settings
    document.getElementById('modelSelect').value = settings.lastUsedModel;
    document.getElementById('temperature').value = settings.lastTemperature;
    document.getElementById('temperatureValue').textContent = settings.lastTemperature;
    document.getElementById('tokensToGenerate').value = settings.lastTokenCount;

    // Menu toggle
    document.getElementById('hamburger').addEventListener('click', toggleMenu);
    document.getElementById('menuOverlay').addEventListener('click', closeMenu);

    // Temperature slider
    const tempSlider = document.getElementById('temperature');
    tempSlider.addEventListener('input', (e) => {
        const val = e.target.value;
        document.getElementById('temperatureValue').textContent = val;
        settings.lastTemperature = parseFloat(val);
        autoSave();
    });

    // Tokens select change
    document.getElementById('tokensToGenerate').addEventListener('change', (e) => {
        settings.lastTokenCount = parseInt(e.target.value);
        autoSave();
    });

    // Model select change
    document.getElementById('modelSelect').addEventListener('change', (e) => {
        settings.lastUsedModel = e.target.value;
        autoSave();
        updateFavoriteButton();
    });

    // Apply settings
    applyTheme(settings.theme);
    document.getElementById('themeSelect').value = settings.theme;
    document.getElementById('fontSizeSelect').value = settings.fontSize;
    document.getElementById('autoSaveInterval').value = settings.autoSaveInterval;
    
    // Apply font size to Quill
    const editorElement = document.querySelector('.ql-editor');
    if (editorElement) {
        editorElement.style.fontSize = settings.fontSize + 'px';
    }

    // Restore last open project/document
    if (settings.lastProjectId && settings.lastDocumentId) {
        currentProjectId = settings.lastProjectId;
        currentDocumentId = settings.lastDocumentId;
        loadDocumentToEditor();
    }
};

/* ========== API KEY MANAGEMENT ========== */

function setApiKey() {
    const input = document.getElementById('apiKeyInput');
    const key = input.value.trim();
    
    if (!key) {
        alert('Please enter a valid API key');
        input.focus();
        return;
    }
    
    apiKey = key;
    localStorage.setItem('openrouterApiKey', apiKey);
    document.getElementById('apiKeyModal').style.display = 'none';
    showToast('API key saved successfully!');
}

function skipApiKey() {
    document.getElementById('apiKeyModal').style.display = 'none';
    showToast('You can add an API key later in Settings');
}

function updateApiKey() {
    const key = document.getElementById('settingsApiKey').value.trim();
    if (!key) {
        showToast('Please enter a valid API key');
        return;
    }
    apiKey = key;
    localStorage.setItem('openrouterApiKey', apiKey);
    document.getElementById('settingsApiKey').value = '';
    showToast('API key updated!');
}

/* ========== DATA PERSISTENCE ========== */

async function autoSave() {
    const data = {
        projects,
        documents,
        settings,
        version: '3.0',
        timestamp: new Date().toISOString()
    };
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(data), 'pym-secret-key-2025').toString();
    try {
        await saveToDB('PymData', encrypted);
    } catch (e) {
        showToast('Auto-save failed.');
    }
}

async function loadData() {
    let encrypted = null;
    try {
        encrypted = await loadFromDB('PymData');
    } catch (e) {
        console.error('Load failed:', e);
    }

    let savedData = null;
    if (encrypted) {
        try {
            const decrypted = CryptoJS.AES.decrypt(encrypted, 'pym-secret-key-2025').toString(CryptoJS.enc.Utf8);
            savedData = JSON.parse(decrypted);
        } catch (e) {
            showToast('Could not load saved data');
        }
    }

    projects = savedData?.projects || [];
    documents = savedData?.documents || [];
    settings = { ...settings, ...(savedData?.settings || {}) };
}

/* ========== BACKUP & RESTORE ========== */

async function createBackup() {
    try {
        const data = {
            projects,
            documents,
            settings,
            version: '3.0',
            timestamp: new Date().toISOString()
        };

        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        
        const date = new Date().toISOString().slice(0, 10);
        a.download = `PymWrite_Backup_${date}.pym`;
        
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Backup created successfully!');
    } catch (err) {
        console.error('Backup failed:', err);
        showToast('Backup failed. Check console.');
    }
}

async function restoreFromBackup(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const data = JSON.parse(e.target.result);

            projects = data.projects || [];
            documents = data.documents || [];
            settings = { ...settings, ...(data.settings || {}) };

            await autoSave();

            updateProjectsList();
            updateProjectDropdown();
            updateDocumentsList();
            
            document.getElementById('themeSelect').value = settings.theme || 'default';
            applyTheme(settings.theme || 'default');

            showToast('Restore complete!');
            closeMenu();
        } catch (err) {
            console.error('Restore failed:', err);
            showToast('Restore failed. Invalid file.');
        }
    };

    reader.readAsText(file);
}

/* ========== PROJECT MANAGEMENT ========== */

function openNewProjectModal() {
    document.getElementById('newProjectModal').style.display = 'flex';
    document.getElementById('newProjectTitle').focus();
}

function closeNewProjectModal() {
    document.getElementById('newProjectModal').style.display = 'none';
    document.getElementById('newProjectForm').reset();
}

function createProject(event) {
    event.preventDefault();

    const project = {
        id: Date.now(),
        title: document.getElementById('newProjectTitle').value.trim(),
        genre: document.getElementById('newProjectGenre').value,
        description: document.getElementById('newProjectDescription').value.trim(),
        targetWordCount: parseInt(document.getElementById('newProjectWordCount').value) || 0,
        currentWordCount: 0,
        created: new Date().toISOString(),
        updated: new Date().toISOString()
    };

    projects.push(project);
    autoSave();
    updateProjectsList();
    updateProjectDropdown();
    closeNewProjectModal();
    showToast(`Project "${project.title}" created!`);
}

function deleteProject(id) {
    const project = projects.find(p => p.id === id);
    if (!project) return;

    if (!confirm(`Delete project "${project.title}" and all its documents?`)) return;

    projects = projects.filter(p => p.id !== id);
    documents = documents.filter(d => d.projectId !== id);

    if (currentProjectId === id) {
        currentProjectId = null;
        currentDocumentId = null;
        document.getElementById('editor').value = '';
        document.getElementById('documentInfo').style.display = 'none';
    }

    autoSave();
    updateProjectsList();
    updateProjectDropdown();
    updateDocumentsList();
    showToast('Project deleted');
}

function switchProject() {
    const projectId = parseInt(document.getElementById('projectSelect').value);
    if (!projectId) {
        currentProjectId = null;
        currentDocumentId = null;
        document.getElementById('documentInfo').style.display = 'none';
        document.getElementById('editor').value = '';
        updateDocumentsList();
        return;
    }

    currentProjectId = projectId;
    currentDocumentId = null;
    settings.lastProjectId = projectId;
    autoSave();
    
    updateDocumentsList();
    document.getElementById('documentInfo').style.display = 'none';
    document.getElementById('editor').value = '';
}

function updateProjectDropdown() {
    const select = document.getElementById('projectSelect');
    select.innerHTML = '<option value="">No Project Selected</option>';
    
    projects.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.title;
        if (project.id === currentProjectId) {
            option.selected = true;
        }
        select.appendChild(option);
    });
}

function updateProjectsList() {
    const container = document.getElementById('projectsList');
    
    if (projects.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999; padding:40px;">No projects yet. Create one to get started!</p>';
        return;
    }

    container.innerHTML = projects.map(project => {
        const projectDocs = documents.filter(d => d.projectId === project.id);
        const totalWords = projectDocs.reduce((sum, doc) => sum + (doc.wordCount || 0), 0);
        project.currentWordCount = totalWords;

        return `
            <div class="project-card">
                <div class="project-header">
                    <div>
                        <h3>${project.title}</h3>
                        <span class="genre-badge">${project.genre}</span>
                    </div>
                    <div class="project-actions">
                        <button class="icon-btn" onclick="viewProjectDocuments(${project.id})" title="View Documents">📄</button>
                        <button class="icon-btn delete-icon" onclick="deleteProject(${project.id})" title="Delete">🗑️</button>
                    </div>
                </div>
                ${project.description ? `<p class="project-description">${project.description}</p>` : ''}
                <div class="project-stats">
                    <div class="stat">
                        <span class="stat-label">Documents:</span>
                        <span class="stat-value">${projectDocs.length}</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Words:</span>
                        <span class="stat-value">${totalWords.toLocaleString()}</span>
                    </div>
                    ${project.targetWordCount > 0 ? `
                        <div class="stat">
                            <span class="stat-label">Progress:</span>
                            <span class="stat-value">${Math.round((totalWords / project.targetWordCount) * 100)}%</span>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function viewProjectDocuments(projectId) {
    currentProjectId = projectId;
    document.getElementById('projectSelect').value = projectId;
    
    // Switch to write tab
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelector('.tab-btn:first-child').classList.add('active');
    document.getElementById('write-tab').classList.add('active');
    
    updateDocumentsList();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ========== DOCUMENT MANAGEMENT ========== */

function openNewDocumentModal() {
    if (!currentProjectId) {
        showToast('Please select a project first');
        return;
    }
    document.getElementById('documentModalTitle').textContent = 'Create New Document';
    document.getElementById('newDocumentModal').style.display = 'flex';
    document.getElementById('newDocumentTitle').focus();
}

function closeNewDocumentModal() {
    document.getElementById('newDocumentModal').style.display = 'none';
    document.getElementById('newDocumentForm').reset();
}

function createDocument(event) {
    event.preventDefault();

    if (!currentProjectId) {
        showToast('Please select a project first');
        return;
    }

    const projectDocs = documents.filter(d => d.projectId === currentProjectId);
    const maxOrder = projectDocs.length > 0 ? Math.max(...projectDocs.map(d => d.order || 0)) : -1;

    const doc = {
        id: Date.now(),
        projectId: currentProjectId,
        title: document.getElementById('newDocumentTitle').value.trim(),
        type: document.getElementById('newDocumentType').value,
        content: '',
        wordCount: 0,
        enabled: true,
        order: maxOrder + 1,
        created: new Date().toISOString(),
        updated: new Date().toISOString()
    };

    documents.push(doc);
    autoSave();
    updateDocumentsList();
    updateProjectsList();
    closeNewDocumentModal();
    showToast(`Document "${doc.title}" created!`);
}

function deleteDocument(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    if (!confirm(`Delete document "${doc.title}"?`)) return;

    documents = documents.filter(d => d.id !== id);

    if (currentDocumentId === id) {
        currentDocumentId = null;
        document.getElementById('editor').value = '';
        document.getElementById('documentInfo').style.display = 'none';
    }

    autoSave();
    updateDocumentsList();
    updateProjectsList();
    showToast('Document deleted');
}

function toggleDocument(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return;

    doc.enabled = !doc.enabled;
    autoSave();
    updateDocumentsList();
}

function openDocumentInEditor(docId) {
    // Save current document before switching
    if (currentDocumentId && hasUnsavedChanges) {
        saveDocument(false);
    }

    currentDocumentId = docId;
    settings.lastDocumentId = docId;
    autoSave();
    loadDocumentToEditor();
}

function loadDocumentToEditor() {
    const doc = documents.find(d => d.id === currentDocumentId);
    if (!doc) return;

    quillEditor.root.innerHTML = doc.content || '';
    document.getElementById('documentTitle').textContent = doc.title;
    document.getElementById('documentType').textContent = doc.type;
    document.getElementById('documentWordCount').textContent = `${doc.wordCount || 0} words`;
    document.getElementById('documentInfo').style.display = 'block';
    
    // Update dropdowns
    document.getElementById('projectSelect').value = doc.projectId;
    currentProjectId = doc.projectId;
    
    hasUnsavedChanges = false;
    updateWordCount();
    updateDocumentsList();
}

function saveDocument(showNotification = true) {
    if (!currentDocumentId) {
        if (showNotification) {
            showToast('No document selected');
        }
        return;
    }

    const doc = documents.find(d => d.id === currentDocumentId);
    if (!doc) return;

    doc.content = quillEditor.root.innerHTML;
    doc.wordCount = countWords(quillEditor.getText());
    doc.updated = new Date().toISOString();

    autoSave();
    hasUnsavedChanges = false;
    
    if (showNotification) {
        showToast('Document saved! 💾');
    }
    
    updateWordCount();
    updateProjectsList();
    updateDocumentsList();
}

function clearEditor() {
    if (!confirm('Clear the editor? Unsaved changes will be lost.')) return;
    quillEditor.setText('');
    hasUnsavedChanges = false;
    updateWordCount();
}

function updateDocumentsList() {
    const container = document.getElementById('documentsList');
    
    if (!currentProjectId) {
        container.innerHTML = '<p style="text-align:center; color:#999; padding:20px;">Select a project to manage documents</p>';
        return;
    }

    let projectDocs = documents.filter(d => d.projectId === currentProjectId);

    if (projectDocs.length === 0) {
        container.innerHTML = '<p style="text-align:center; color:#999; padding:20px;">No documents yet. Create one to get started!</p>';
        return;
    }

    // Ensure all documents have an order property
    projectDocs.forEach((doc, index) => {
        if (doc.order === undefined) {
            doc.order = index;
        }
    });

    // Sort ONLY by order (no grouping)
    projectDocs.sort((a, b) => a.order - b.order);

    let html = '';
    projectDocs.forEach(doc => {
        const isActive = doc.id === currentDocumentId;
        html += `
            <div class="document-card ${doc.enabled ? 'enabled' : 'disabled'} ${isActive ? 'active-doc' : ''}" 
                 draggable="true" 
                 data-doc-id="${doc.id}"
                 ondragstart="handleDragStart(event)" 
                 ondragover="handleDragOver(event)" 
                 ondrop="handleDrop(event)" 
                 ondragend="handleDragEnd(event)"
                 onclick="openDocumentInEditor(${doc.id})">
                <div class="document-header">
                    <div class="drag-handle" title="Drag to reorder">⋮⋮</div>
                    <label class="toggle-container" onclick="event.stopPropagation();">
                        <input type="checkbox" ${doc.enabled ? 'checked' : ''} onchange="toggleDocument(${doc.id})">
                        <span class="toggle-slider"></span>
                    </label>
                    <div class="document-title">
                        <h4><span class="doc-type-icon">${getTypeIcon(doc.type)}</span> ${doc.title}</h4>
                        <span class="document-meta">${doc.wordCount || 0} words • ${doc.type}</span>
                    </div>
                    <div class="document-actions">
                        <button class="icon-btn delete-icon" onclick="event.stopPropagation(); deleteDocument(${doc.id})" title="Delete">🗑️</button>
                    </div>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// Drag and Drop handlers
function handleDragStart(e) {
    draggedElement = e.target.closest('.document-card');
    if (!draggedElement) return;
    
    draggedElement.style.opacity = '0.4';
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/html', draggedElement.innerHTML);
}

function handleDragOver(e) {
    if (e.preventDefault) {
        e.preventDefault();
    }
    e.dataTransfer.dropEffect = 'move';
    
    const target = e.target.closest('.document-card');
    if (target && target !== draggedElement) {
        const rect = target.getBoundingClientRect();
        const midpoint = rect.top + rect.height / 2;
        
        // Clear all borders first
        document.querySelectorAll('.document-card').forEach(card => {
            card.style.borderTop = '';
            card.style.borderBottom = '';
        });
        
        if (e.clientY < midpoint) {
            target.style.borderTop = '3px solid var(--accent-primary)';
        } else {
            target.style.borderBottom = '3px solid var(--accent-primary)';
        }
    }
    
    return false;
}

function handleDrop(e) {
    if (e.stopPropagation) {
        e.stopPropagation();
    }
    
    const target = e.target.closest('.document-card');
    if (draggedElement && target && draggedElement !== target) {
        const draggedId = parseInt(draggedElement.dataset.docId);
        const targetId = parseInt(target.dataset.docId);
        
        const draggedDoc = documents.find(d => d.id === draggedId);
        const targetDoc = documents.find(d => d.id === targetId);
        
        if (draggedDoc && targetDoc && draggedDoc.projectId === targetDoc.projectId) {
            // Get all docs in this project sorted by current order
            const projectDocs = documents
                .filter(d => d.projectId === draggedDoc.projectId)
                .sort((a, b) => (a.order || 0) - (b.order || 0));
            
            // Find current positions
            const draggedIndex = projectDocs.findIndex(d => d.id === draggedId);
            const targetIndex = projectDocs.findIndex(d => d.id === targetId);
            
            // Remove dragged doc
            const [removed] = projectDocs.splice(draggedIndex, 1);
            
            // Determine insert position based on mouse position
            const rect = target.getBoundingClientRect();
            const midpoint = rect.top + rect.height / 2;
            let insertIndex = targetIndex;
            
            // If dragging from above to below, adjust index
            if (draggedIndex < targetIndex) {
                insertIndex = e.clientY < midpoint ? targetIndex - 1 : targetIndex;
            } else {
                insertIndex = e.clientY < midpoint ? targetIndex : targetIndex + 1;
            }
            
            // Insert at new position
            projectDocs.splice(insertIndex, 0, removed);
            
            // Reassign orders
            projectDocs.forEach((doc, index) => {
                doc.order = index;
            });
            
            autoSave();
            updateDocumentsList();
        }
    }
    
    // Clear border indicators
    document.querySelectorAll('.document-card').forEach(card => {
        card.style.borderTop = '';
        card.style.borderBottom = '';
    });
    
    return false;
}

function handleDragEnd(e) {
    if (draggedElement) {
        draggedElement.style.opacity = '1';
    }
    
    // Clear all border indicators
    document.querySelectorAll('.document-card').forEach(card => {
        card.style.borderTop = '';
        card.style.borderBottom = '';
    });
    
    draggedElement = null;
}

function getTypeIcon(type) {
    const icons = {
        'Chapter': '📖',
        'Instructions': '📋',
        'Synopsis': '📝',
        'Writing Style': '✍️',
        'Characters': '👥',
        'Locations': '🗺️',
        'Worldbuilding': '🌍',
        'Plot': '🎭',
        'Research': '🔬',
        'Notes': '📌',
        'Other': '📄'
    };
    return icons[type] || '📄';
}

/* ========== WORD COUNT ========== */

function countWords(text) {
    if (!text || text.trim() === '') return 0;
    return text.trim().split(/\s+/).length;
}

function updateWordCount() {
    const text = quillEditor.getText();
    const words = countWords(text);
    document.getElementById('wordCount').textContent = words.toLocaleString();
    
    if (currentDocumentId) {
        document.getElementById('documentWordCount').textContent = `${words.toLocaleString()} words`;
    }
}

/* ========== AUTO-SAVE TIMER ========== */

function resetAutoSaveTimer() {
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
    }
    
    autoSaveTimer = setTimeout(() => {
        if (hasUnsavedChanges && currentDocumentId) {
            saveDocument(false);
        }
    }, settings.autoSaveInterval);
}

/* ========== MODEL SELECTION ========== */

async function fetchOpenRouterModels() {
    if (modelsLoaded) return;

    try {
        showToast('Loading models from OpenRouter...');
        
        const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: {
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Pym Write'
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch models: ${response.status}`);
        }

        const data = await response.json();
        
        // Transform the API response into our format
        OPENROUTER_MODELS = data.data.map(model => ({
            id: model.id,
            name: model.name,
            provider: extractProvider(model.id),
            contextLength: model.context_length || 0,
            pricing: model.pricing || {},
            isFree: isFreeModel(model.pricing)
        }));

        // Sort models: free first, then by provider
        OPENROUTER_MODELS.sort((a, b) => {
            if (a.isFree && !b.isFree) return -1;
            if (!a.isFree && b.isFree) return 1;
            return a.provider.localeCompare(b.provider);
        });

        modelsLoaded = true;
        populateModelSelect();
        showToast(`Loaded ${OPENROUTER_MODELS.length} models!`);
        
    } catch (error) {
        console.error('Error fetching models:', error);
        showToast('Failed to load models. Using default list.');
        
        // Fallback to a basic list if API fails
        OPENROUTER_MODELS = [
            { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', isFree: false },
            { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'OpenAI', isFree: false },
            { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo', provider: 'OpenAI', isFree: false },
            { id: 'google/gemini-pro', name: 'Gemini Pro', provider: 'Google', isFree: false },
            { id: 'meta-llama/llama-3-8b-instruct:free', name: 'Llama 3 8B (Free)', provider: 'Meta', isFree: true }
        ];
        modelsLoaded = true;
        populateModelSelect();
    }
}

function extractProvider(modelId) {
    const parts = modelId.split('/');
    if (parts.length > 0) {
        const provider = parts[0];
        return provider.charAt(0).toUpperCase() + provider.slice(1);
    }
    return 'Unknown';
}

function isFreeModel(pricing) {
    if (!pricing) return false;
    
    const promptPrice = parseFloat(pricing.prompt) || 0;
    const completionPrice = parseFloat(pricing.completion) || 0;
    
    return promptPrice === 0 && completionPrice === 0;
}

function populateModelSelect() {
    const select = document.getElementById('modelSelect');
    const showFavorites = document.getElementById('showFavoritesOnly')?.checked || false;
    const showFreeOnly = document.getElementById('showFreeOnly')?.checked || false;
    
    if (!modelsLoaded || OPENROUTER_MODELS.length === 0) {
        select.innerHTML = '<option value="">Loading models...</option>';
        return;
    }
    
    select.innerHTML = '';
    
    let modelsToShow = OPENROUTER_MODELS;
    
    if (showFavorites) {
        modelsToShow = modelsToShow.filter(m => settings.favoriteModels.includes(m.id));
    }
    
    if (showFreeOnly) {
        modelsToShow = modelsToShow.filter(m => m.isFree);
    }

    if (modelsToShow.length === 0) {
        select.innerHTML = '<option value="">No models match filters</option>';
        return;
    }

    const freeModels = modelsToShow.filter(m => m.isFree);
    const paidModels = modelsToShow.filter(m => !m.isFree);

    if (freeModels.length > 0) {
        const freeGroup = document.createElement('optgroup');
        freeGroup.label = '🆓 Free Models';
        freeModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = `${model.name} (${model.provider})`;
            freeGroup.appendChild(option);
        });
        select.appendChild(freeGroup);
    }

    if (paidModels.length > 0) {
        const paidGroup = document.createElement('optgroup');
        paidGroup.label = '💳 Paid Models';
        paidModels.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = `${model.name} (${model.provider})`;
            paidGroup.appendChild(option);
        });
        select.appendChild(paidGroup);
    }
    
    // Set saved model
    if (settings.lastUsedModel) {
        select.value = settings.lastUsedModel;
    }
    
    updateFavoriteButton();
}

function toggleFavoriteModel() {
    const modelId = document.getElementById('modelSelect').value;
    if (!modelId) return;

    const index = settings.favoriteModels.indexOf(modelId);
    if (index > -1) {
        settings.favoriteModels.splice(index, 1);
        showToast('Removed from favorites');
    } else {
        settings.favoriteModels.push(modelId);
        showToast('Added to favorites ⭐');
    }

    autoSave();
    updateFavoriteButton();
}

function updateFavoriteButton() {
    const modelId = document.getElementById('modelSelect').value;
    const btn = document.getElementById('favoriteBtn');
    if (!btn) return;

    if (settings.favoriteModels.includes(modelId)) {
        btn.textContent = '⭐';
        btn.title = 'Remove from favorites';
    } else {
        btn.textContent = '☆';
        btn.title = 'Add to favorites';
    }
}

function toggleFavoritesFilter() {
    populateModelSelect();
}

/* ========== AI FUNCTIONS ========== */

// Default prompts
const DEFAULT_SYSTEM_PROMPT = `You are a creative writing assistant helping to continue a story. 
{CONTEXT_NOTES}
{DOCUMENTS_CONTEXT}

Generate approximately {TOKENS_TO_GENERATE} tokens that naturally continue the narrative. Match the writing style, tone, and voice of the existing text. Do not repeat content from the existing text.`;

const DEFAULT_USER_PROMPT = `Here is the story so far:\n\n{RECENT_TEXT}\n\nPlease continue the story naturally from where it left off.`;

function getSystemPrompt(tokensToGenerate, contextNotes, documentsContext) {
    let prompt = settings.customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
    
    prompt = prompt.replace('{TOKENS_TO_GENERATE}', tokensToGenerate);
    
    if (contextNotes) {
        prompt = prompt.replace('{CONTEXT_NOTES}', `\n\nContext about the story:\n${contextNotes}`);
    } else {
        prompt = prompt.replace('{CONTEXT_NOTES}', '');
    }
    
    if (documentsContext) {
        prompt = prompt.replace('{DOCUMENTS_CONTEXT}', documentsContext);
    } else {
        prompt = prompt.replace('{DOCUMENTS_CONTEXT}', '');
    }
    
    return prompt;
}

function getUserPrompt(recentText) {
    let prompt = settings.customUserPrompt || DEFAULT_USER_PROMPT;
    prompt = prompt.replace('{RECENT_TEXT}', recentText);
    return prompt;
}

function previewAiRequest() {
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }

    const currentText = quillEditor.getText();

    // if (currentText.trim().length < 50) {
    //     showToast('Write at least 50 characters to preview');
    //     return;
    // }

    const model = document.getElementById('modelSelect').value;
    const tokensToGenerate = parseInt(document.getElementById('tokensToGenerate').value);
    const temperature = parseFloat(document.getElementById('temperature').value);
    const contextNotes = document.getElementById('contextNotes').value;

    // Get enabled documents for this project (excluding current document), sorted by order
    const enabledDocs = documents
        .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
        .sort((a, b) => a.order - b.order);
    
    let documentsContext = '';
    if (enabledDocs.length > 0) {
        documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
            const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
            return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
        }).join('\n');
    }

    const recentText = currentText.slice(-4000);

    const systemPrompt = getSystemPrompt(tokensToGenerate, contextNotes, documentsContext);
    const userPrompt = getUserPrompt(recentText);

    const requestBody = {
        model: model,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: temperature,
        max_tokens: tokensToGenerate
    };

    showRequestPreview(requestBody);
}

function showRequestPreview(requestBody) {
    const modal = document.getElementById('requestPreviewModal');
    const apiContent = document.getElementById('requestPreviewContent');
    const docsContent = document.getElementById('documentsPreviewContent');
    
    // Format API request
    const formattedJson = JSON.stringify(requestBody, null, 2);
    apiContent.textContent = formattedJson;
    
    // Format documents preview
    const enabledDocs = documents
        .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
        .sort((a, b) => a.order - b.order);
    
    let docsPreview = '';
    if (enabledDocs.length === 0) {
        docsPreview = 'No enabled documents to preview.';
    } else {
        enabledDocs.forEach(doc => {
            const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
            docsPreview += `[${doc.title}:Start]\n\n${docText.trim()}\n\n[${doc.title}:End]\n\n`;
        });
    }
    
    docsContent.textContent = docsPreview.trim();
    
    modal.style.display = 'flex';
}

function closeRequestPreview() {
    document.getElementById('requestPreviewModal').style.display = 'none';
}

function copyRequestPreview() {
    const activeTab = document.querySelector('.preview-tab-btn.active').dataset.tab;
    const content = activeTab === 'api' 
        ? document.getElementById('requestPreviewContent').textContent
        : document.getElementById('documentsPreviewContent').textContent;
    
    navigator.clipboard.writeText(content).then(() => {
        showToast('Copied to clipboard! 📋');
    }).catch(() => {
        showToast('Failed to copy');
    });
}

function switchPreviewTab(tabName) {
    document.querySelectorAll('.preview-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.preview-tab-content').forEach(content => content.classList.remove('active'));
    
    event.target.classList.add('active');
    document.getElementById(`preview-${tabName}-tab`).classList.add('active');
}

async function continueStory() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }

    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }

    const currentText = quillEditor.getText();

    if (currentText.trim().length < 50) {
        showToast('Write at least 50 characters before using AI to continue');
        return;
    }

    const continueBtn = document.getElementById('continueBtn');
    continueBtn.disabled = true;
    continueBtn.innerHTML = '<span class="toolbar-icon">⏳</span><span class="toolbar-label">Generating...</span>';

    try {
        const model = document.getElementById('modelSelect').value;
        const tokensToGenerate = parseInt(document.getElementById('tokensToGenerate').value);
        const temperature = parseFloat(document.getElementById('temperature').value);
        const contextNotes = document.getElementById('contextNotes').value;

        const enabledDocs = documents
            .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
            .sort((a, b) => a.order - b.order);
        
        let documentsContext = '';
        if (enabledDocs.length > 0) {
            documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
                const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
                return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
            }).join('\n');
        }

        const recentText = currentText.slice(-4000);

        const systemPrompt = getSystemPrompt(tokensToGenerate, contextNotes, documentsContext);
        const userPrompt = getUserPrompt(recentText);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Pym Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature,
                max_tokens: tokensToGenerate
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const aiText = data.choices[0].message.content.trim();

        lastAiResponse = aiText;
        showAiOutput(aiText);

    } catch (error) {
        console.error('AI Error:', error);
        showToast('AI generation failed. Check your API key and try again.');
    } finally {
        continueBtn.disabled = false;
        continueBtn.innerHTML = '<span class="toolbar-icon">✨</span><span class="toolbar-label">Continue</span>';
    }
}

// NEW: Continue from cursor position (floating button or Tab)
async function continueFromCursor() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }

    const range = quillEditor.getSelection();
    if (!range || range.index < 30) {
        showToast('Place your cursor after some text to continue');
        return;
    }

    hideFloatingContinueButton();

    const currentText = quillEditor.getText();
    if (currentText.trim().length < 50) {
        showToast('Write a little more before continuing');
        return;
    }

    // Visual feedback
    const btn = document.getElementById('continueBtn');
    const originalHTML = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="toolbar-icon">⏳</span><span class="toolbar-label">Generating...</span>';

    try {
        const model = document.getElementById('modelSelect').value;
        const tokensToGenerate = parseInt(document.getElementById('tokensToGenerate').value);
        const temperature = parseFloat(document.getElementById('temperature').value);
        const contextNotes = document.getElementById('contextNotes').value;

        const enabledDocs = documents
            .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
            .sort((a, b) => a.order - b.order);

        let documentsContext = '';
        if (enabledDocs.length > 0) {
            documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
                const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
                return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
            }).join('\n');
        }

        const recentText = currentText.slice(-4000);
        const systemPrompt = getSystemPrompt(tokensToGenerate, contextNotes, documentsContext);
        const userPrompt = getUserPrompt(recentText);

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Pym Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature,
                max_tokens: tokensToGenerate,
                stream: false
            })
        });

        if (!response.ok) throw new Error(`API error: ${response.status}`);
        const data = await response.json();
        const aiText = data.choices[0].message.content.trim();

        // Stream-type insertion at cursor
        streamInsertAtCursor(aiText, range.index);

    } catch (error) {
        console.error('AI Error:', error);
        showToast('Generation failed. Check API key and internet.');
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalHTML;
    }
}

// Show floating button when cursor is in a good spot
function updateFloatingContinueButton() {
    const range = quillEditor.getSelection();
    const btn = document.getElementById('floatingContinueBtn');

    if (!range || range.length > 0 || range.index < 50) {
        btn.style.display = 'none';
        return;
    }

    const textBefore = quillEditor.getText(0, range.index);
    if (!textBefore.trim() || textBefore.trim().length < 50) {
        btn.style.display = 'none';
        return;
    }

    // THE REAL FIX: Quill's getBounds() is relative to the .ql-editor scrolling container
    const bounds = quillEditor.getBounds(range.index);
    const editorScrollContainer = document.querySelector('.ql-editor');

    // Convert to viewport coordinates
    const containerRect = editorScrollContainer.getBoundingClientRect();
    const scrollTop = editorScrollContainer.scrollTop;
    const scrollLeft = editorScrollContainer.scrollLeft;

    const x = containerRect.left + bounds.left + scrollLeft + 12;
    const y = containerRect.top + bounds.bottom + scrollTop + 8;

    btn.style.position = 'fixed';
    btn.style.left = x + 'px';
    btn.style.top = y + 'px';
    btn.style.display = 'block';
    btn.classList.add('ready');
}

function hideFloatingContinueButton() {
    const btn = document.getElementById('floatingContinueBtn');
    btn.style.display = 'none';
    btn.classList.remove('ready');
}

// Beautiful character-by-character streaming effect
function streamInsertAtCursor(text, startIndex) {
    let i = 0;
    const interval = setInterval(() => {
        if (i < text.length) {
            const char = text[i];
            quillEditor.insertText(startIndex + i, char, 'api');
            i++;
            quillEditor.setSelection(startIndex + i, 0);
            // Auto-scroll to keep cursor in view
            quillEditor.scrollIntoView();
        } else {
            clearInterval(interval);
            hasUnsavedChanges = true;
            updateWordCount();
            showToast('Continued! ✨');
        }
    }, 16); // ~60 FPS typing feel
}

async function improveText() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }

    const selection = quillEditor.getSelection();
    if (!selection || selection.length === 0) {
        showToast('Please select text to improve');
        return;
    }

    const selectedText = quillEditor.getText(selection.index, selection.length);

    if (selectedText.trim().length < 10) {
        showToast('Please select at least 10 characters to improve');
        return;
    }

    showToast('Improving selected text...');

    try {
        const model = document.getElementById('modelSelect').value;
        const temperature = parseFloat(document.getElementById('temperature').value);

        const systemPrompt = 'You are a professional editor. Improve the provided text by enhancing clarity, style, and readability while maintaining the original meaning and voice. Return only the improved text without any preamble or explanation.';

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Pym Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: selectedText }
                ],
                temperature: temperature
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const improvedText = data.choices[0].message.content.trim();

        lastAiResponse = improvedText;
        showAiOutput(improvedText);

    } catch (error) {
        console.error('AI Error:', error);
        showToast('Text improvement failed. Check your API key.');
    }
}

async function brainstorm() {
    if (!apiKey) {
        showToast('Please add an API key in Settings');
        return;
    }

    showToast('Generating ideas...');

    try {
        const model = document.getElementById('modelSelect').value;
        const temperature = parseFloat(document.getElementById('temperature').value);
        const contextNotes = document.getElementById('contextNotes').value;
        const currentText = quillEditor.getText().slice(-2000);

        const enabledDocs = documents
            .filter(d => d.projectId === currentProjectId && d.enabled && d.id !== currentDocumentId)
            .sort((a, b) => a.order - b.order);
        
        let documentsContext = '';
        if (enabledDocs.length > 0) {
            documentsContext = '\n\nAdditional Context:\n' + enabledDocs.map(doc => {
                const docText = new DOMParser().parseFromString(doc.content, 'text/html').body.textContent || '';
                return `--- ${doc.type}: ${doc.title} ---\n${docText}\n`;
            }).join('\n');
        }

        const systemPrompt = `You are a creative writing assistant. Generate 5 creative ideas for continuing or enhancing the story.
${contextNotes ? `\n\nContext:\n${contextNotes}` : ''}
${documentsContext}

Format your response as a numbered list.`;

        const userPrompt = currentText 
            ? `Based on this story excerpt:\n\n${currentText}\n\nProvide 5 creative ideas for what could happen next or how to develop the narrative.`
            : 'Provide 5 creative story ideas or writing prompts.';

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': window.location.origin,
                'X-Title': 'Pym Write'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: temperature
            })
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status}`);
        }

        const data = await response.json();
        const ideas = data.choices[0].message.content.trim();

        lastAiResponse = ideas;
        showAiOutput(ideas);

    } catch (error) {
        console.error('AI Error:', error);
        showToast('Brainstorming failed. Check your API key.');
    }
}

function showAiOutput(text) {
    document.getElementById('aiOutputContent').textContent = text;
    document.getElementById('aiOutput').style.display = 'block';
}

function closeAiOutput() {
    document.getElementById('aiOutput').style.display = 'none';
}

function insertAiText() {
    const selection = quillEditor.getSelection();
    const index = selection ? selection.index : quillEditor.getLength();
    
    quillEditor.insertText(index, '\n\n' + lastAiResponse);
    hasUnsavedChanges = true;
    updateWordCount();
    closeAiOutput();
    showToast('AI text inserted! 📝');
}

function copyAiText() {
    navigator.clipboard.writeText(lastAiResponse).then(() => {
        showToast('Copied to clipboard! 📋');
    }).catch(() => {
        showToast('Failed to copy');
    });
}

/* ========== EDITOR FORMATTING ========== */

function convertMarkdownToRichText() {
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }
    
    const text = quillEditor.getText();
    
    if (!text || text.trim().length === 0) {
        showToast('No text to convert');
        return;
    }
    
    const rawHtml = marked.parse(text, { breaks: true });

    const cleanHtml = DOMPurify.sanitize(rawHtml); // Clean it before pasting

     // Clear editor

    quillEditor.setText('');

    quillEditor.clipboard.dangerouslyPasteHTML(0, cleanHtml);
        
        hasUnsavedChanges = true;
        showToast('Markdown converted! ✨');
}

function formatForFiction() {
    if (!currentDocumentId) {
        showToast('Please select a document first');
        return;
    }
    
    const text = quillEditor.getText();
    
    if (!text || text.trim().length === 0) {
        showToast('No text to format');
        return;
    }
    
    // Clear current formatting
    quillEditor.removeFormat(0, quillEditor.getLength());
    
    // Get all paragraphs
    const paragraphs = text.split('\n\n');
    
    // Clear editor
    quillEditor.setText('');
    
    let currentIndex = 0;
    
    paragraphs.forEach((para, i) => {
        const trimmed = para.trim();
        if (!trimmed) return;
        
        // Insert paragraph with indent
        quillEditor.insertText(currentIndex, trimmed, {
            indent: 1
        });
        currentIndex += trimmed.length;
        
        // Add double line break between paragraphs
        if (i < paragraphs.length - 1) {
            quillEditor.insertText(currentIndex, '\n\n');
            currentIndex += 2;
        }
    });
    
    hasUnsavedChanges = true;
    showToast('Formatted for fiction! 📖');
}

/* ========== SETTINGS ========== */

function openSettingsModal() {
    document.getElementById('customSystemPrompt').value = settings.customSystemPrompt || DEFAULT_SYSTEM_PROMPT;
    document.getElementById('customUserPrompt').value = settings.customUserPrompt || DEFAULT_USER_PROMPT;
    
    document.getElementById('settingsModal').style.display = 'flex';
}

function closeSettingsModal() {
    document.getElementById('settingsModal').style.display = 'none';
}

function saveSettings() {
    settings.theme = document.getElementById('themeSelect').value;
    settings.fontSize = parseInt(document.getElementById('fontSizeSelect').value);
    settings.autoSaveInterval = parseInt(document.getElementById('autoSaveInterval').value);
    
    applyTheme(settings.theme);
    
    // Apply font size to Quill editor
    const editorElement = document.querySelector('.ql-editor');
    if (editorElement) {
        editorElement.style.fontSize = settings.fontSize + 'px';
    }
    
    autoSave();
    showToast('Settings saved');
}

function saveCustomPrompts() {
    const systemPrompt = document.getElementById('customSystemPrompt').value.trim();
    const userPrompt = document.getElementById('customUserPrompt').value.trim();
    
    if (!systemPrompt || !userPrompt) {
        showToast('Prompts cannot be empty');
        return;
    }
    
    settings.customSystemPrompt = systemPrompt;
    settings.customUserPrompt = userPrompt;
    
    autoSave();
    showToast('Custom prompts saved! ✅');
}

function restoreDefaultPrompts() {
    if (!confirm('Restore default prompts? Your custom prompts will be lost.')) return;
    
    settings.customSystemPrompt = null;
    settings.customUserPrompt = null;
    
    document.getElementById('customSystemPrompt').value = DEFAULT_SYSTEM_PROMPT;
    document.getElementById('customUserPrompt').value = DEFAULT_USER_PROMPT;
    
    autoSave();
    showToast('Default prompts restored! 🔄');
}

function applyTheme(themeName) {
    if (themeName === 'default') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', themeName);
    }
}

/* ========== UI FUNCTIONS ========== */

function switchSidebarTab(tabName) {
    document.querySelectorAll('.sidebar-tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.sidebar-tab-content').forEach(content => content.classList.remove('active'));

    event.target.classList.add('active');
    document.getElementById(`sidebar-${tabName}-tab`).classList.add('active');
}

function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));

    event.target.classList.add('active');
    document.getElementById(`${tabName}-tab`).classList.add('active');

    if (tabName === 'projects') {
        updateProjectsList();
    }
}

function toggleMenu() {
    const menu = document.getElementById('menu');
    const hamburger = document.getElementById('hamburger');
    const overlay = document.getElementById('menuOverlay');
    
    menu.classList.toggle('open');
    hamburger.classList.toggle('open');
    overlay.classList.toggle('open');
}

function closeMenu() {
    document.getElementById('menu').classList.remove('open');
    document.getElementById('hamburger').classList.remove('open');
    document.getElementById('menuOverlay').classList.remove('open');
}

function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}
