document.addEventListener('DOMContentLoaded', () => {
    // MathJax初始化 - 确保页面加载时处理现有公式
    if (window.MathJax) {
        window.MathJax.typesetPromise().catch((err) => console.error('MathJax initialization error:', err));
    }

    // --- DOM 元素 ---
    const newChatBtn = document.getElementById('new-chat-btn');
    const modal = document.getElementById('new-chat-modal');
    const closeModalBtn = document.querySelector('.close-btn');
    const newAgentForm = document.getElementById('new-agent-form');
    const sendBtn = document.getElementById('send-btn');
    const userInput = document.getElementById('user-input');
    const historyList = document.getElementById('history-list');
    const chatMessages = document.getElementById('chat-messages');
    const chatTitle = document.getElementById('chat-title');
    
    // 新增 - 选项卡相关元素
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    const agentSelectionList = document.getElementById('agent-selection-list');
    
    // 语音输入相关元素
    const voiceInputBtn = document.getElementById('voice-input-btn');
    const voiceInputModal = document.getElementById('voice-input-modal');
    const closeVoiceModalBtn = document.querySelector('.close-voice-btn');
    const startRecordingBtn = document.getElementById('start-recording-btn');
    const stopRecordingBtn = document.getElementById('stop-recording-btn');
    const recordingIndicator = document.getElementById('recording-indicator');
    const voiceTextResult = document.getElementById('voice-text');
    const useVoiceTextBtn = document.getElementById('use-voice-text-btn');
    const voiceResult = document.querySelector('.voice-result');

    // 语音通话相关元素
    const voiceCallBtn = document.getElementById('voice-call-btn');

    // 对话上下文管理相关元素
    const refreshContextBtn = document.getElementById('refresh-context-btn');
    const memoryStatusBtn = document.getElementById('memory-status-btn');

    // --- 状态管理 ---
    let currentConversationId = null;
    let isProcessingMessage = false;
    let mediaRecorder = null;
    let audioChunks = [];
    let currentlyPlayingAudio = null;
    let isVoiceCallActive = false;
    let voiceCallTimer = null;
    let silenceDetector = null;
    let selectedAgentId = null; // 新增 - 当前选择的智能体ID
    const SILENCE_THRESHOLD = 0.01;
    const SILENCE_DURATION = 1000; // 1秒静音视为说话结束

    // 设置过滤参数
    const MIN_VOLUME_THRESHOLD = 0.05; // 更高的音量阈值，忽略小声音
    const MIN_RECORDING_DURATION = 600; // 最短录音时长(毫秒)，太短的可能是噪音
    const MIN_SPEECH_LENGTH = 2; // 最短有效文本长度，字符数
    const MEANINGLESS_PATTERNS = [
        /^[啊哦嗯呃嘿哼唔嘻呀]+$/,  // 只包含语气词
        /^[\s,.!?;:，。！？；：]+$/  // 只包含标点符号
    ];

    // 添加全局变量来跟踪AI是否在说话
    let isAISpeaking = false;

    // 添加全局变量
    let isMicrophoneActive = true;
    let currentMediaStream = null;

    // --- 事件监听 ---

    // 打开新建对话弹窗
    newChatBtn.addEventListener('click', () => {
        modal.style.display = 'block';
        // 加载智能体列表
        loadAgentList();
        // 默认显示选择智能体选项卡
        document.querySelector('.tab-btn[data-tab="select-agent"]').click();
    });

    // 关闭新建对话弹窗
    closeModalBtn.addEventListener('click', () => {
        modal.style.display = 'none';
        selectedAgentId = null; // 重置选择的智能体
    });
    window.addEventListener('click', (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
            selectedAgentId = null; // 重置选择的智能体
        }
        if (event.target == voiceInputModal) {
            stopRecording();
            voiceInputModal.style.display = 'none';
        }
    });
    
    // 选项卡切换
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // 移除所有选项卡的active类
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // 添加当前选项卡的active类
            btn.classList.add('active');
            const tabId = btn.dataset.tab;
            document.getElementById(`${tabId}-tab`).classList.add('active');
        });
    });

    // 提交新智能体表单
    newAgentForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        
        const formData = new FormData(newAgentForm);
        const agentName = formData.get('agent-name');
        const agentType = formData.get('agent-type');
        const agentRole = formData.get('agent-role');
        const files = document.getElementById('knowledge-files').files;
        
        // 添加文件到FormData
        for (let i = 0; i < files.length; i++) {
            formData.append('files', files[i]);
        }
        
        // 重命名字段以匹配后端API
        formData.append('name', agentName);
        formData.append('agent_type', agentType);
        formData.append('role', agentRole);
        formData.delete('agent-name');
        formData.delete('agent-type');
        formData.delete('agent-role');
        
        try {
            const response = await fetch('/api/agents', {
                method: 'POST',
                body: formData
            });
            
            if (!response.ok) {
                throw new Error('创建智能体失败');
            }
            
            const data = await response.json();
            
            // 切换到新创建的对话
            currentConversationId = data.conversation_id;
            chatTitle.textContent = `与 ${data.agent.name} 的对话`;
            
            // 清空聊天窗口
            clearChatMessages();
            
            // 添加欢迎消息
            appendMessage(`你好！我是${data.agent.name}。${data.agent.role ? '我的角色是: ' + data.agent.role : ''}`, 'assistant');
            
            // 重新加载历史记录
            await loadHistory();
            
            // 关闭弹窗
            modal.style.display = 'none';
            
            // 重置表单
            newAgentForm.reset();
            
        } catch (error) {
            alert('创建智能体失败: ' + error.message);
            console.error('创建智能体错误:', error);
        }
    });

    // 发送消息
    sendBtn.addEventListener('click', sendMessage);
    userInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });
    
    // 语音输入相关事件
    voiceInputBtn.addEventListener('click', openVoiceInputModal);
    closeVoiceModalBtn.addEventListener('click', () => {
        stopRecording();
        voiceInputModal.style.display = 'none';
    });
    startRecordingBtn.addEventListener('click', startRecording);
    stopRecordingBtn.addEventListener('click', stopRecording);
    useVoiceTextBtn.addEventListener('click', useVoiceText);
    
    // 语音通话相关事件
    voiceCallBtn.addEventListener('click', toggleVoiceCall);

    // 对话上下文管理相关事件
    refreshContextBtn.addEventListener('click', refreshConversationContext);
    memoryStatusBtn.addEventListener('click', showMemoryStatus);
    
    // --- 新增 - 智能体选择相关功能 ---
    
    /**
     * 加载智能体列表
     */
    async function loadAgentList() {
        try {
            // 显示加载中
            agentSelectionList.innerHTML = '<div class="agent-list-loading">正在加载智能体列表...</div>';
            
            const response = await fetch('/api/agents');
            if (!response.ok) {
                throw new Error('获取智能体列表失败');
            }
            
            const agents = await response.json();
            
            // 如果没有智能体，显示提示信息
            if (agents.length === 0) {
                agentSelectionList.innerHTML = '<div class="agent-list-loading">暂无可用智能体，请创建新智能体</div>';
                // 自动切换到创建智能体选项卡
                document.querySelector('.tab-btn[data-tab="create-agent"]').click();
                return;
            }
            
            // 清空列表
            agentSelectionList.innerHTML = '';
            
            // 添加智能体项
            agents.forEach(agent => {
                const agentItem = document.createElement('div');
                agentItem.classList.add('agent-list-item');
                agentItem.dataset.agentId = agent.id;
                
                const agentInfo = document.createElement('div');
                agentInfo.classList.add('agent-info');
                
                const agentName = document.createElement('div');
                agentName.classList.add('agent-name');
                agentName.textContent = agent.name;
                agentInfo.appendChild(agentName);
                
                const agentDescription = document.createElement('div');
                agentDescription.classList.add('agent-description');
                agentDescription.textContent = agent.has_knowledge_base 
                    ? '包含知识库' 
                    : '无知识库';
                agentInfo.appendChild(agentDescription);
                
                agentItem.appendChild(agentInfo);
                
                // 添加删除按钮
                const deleteBtn = document.createElement('button');
                deleteBtn.classList.add('agent-delete-btn');
                deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
                deleteBtn.title = '删除智能体';
                
                // 删除按钮点击事件
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // 阻止事件冒泡
                    deleteAgent(agent.id, agent.name);
                });
                
                agentItem.appendChild(deleteBtn);
                
                // 点击选择智能体
                agentItem.addEventListener('click', () => {
                    // 移除其他选中项
                    document.querySelectorAll('.agent-list-item').forEach(item => {
                        item.classList.remove('selected');
                    });
                    
                    // 选中当前项
                    agentItem.classList.add('selected');
                    selectedAgentId = agent.id;
                });
                
                agentSelectionList.appendChild(agentItem);
            });
            
            // 添加开始聊天按钮
            const startChatBtn = document.createElement('button');
            startChatBtn.classList.add('start-chat-btn');
            startChatBtn.textContent = '开始对话';
            startChatBtn.disabled = true; // 初始状态禁用
            
            // 监听按钮点击事件
            startChatBtn.addEventListener('click', createConversationWithAgent);
            
            // 添加到选择智能体选项卡
            document.getElementById('select-agent-tab').appendChild(startChatBtn);
            
            // 添加选中智能体的监听
            document.querySelectorAll('.agent-list-item').forEach(item => {
                item.addEventListener('click', () => {
                    startChatBtn.disabled = false;
                });
            });
            
        } catch (error) {
            agentSelectionList.innerHTML = `<div class="agent-list-loading">加载失败: ${error.message}</div>`;
            console.error('加载智能体列表错误:', error);
        }
    }
    
    /**
     * 使用选中的智能体创建新对话
     */
    async function createConversationWithAgent() {
        if (!selectedAgentId) {
            alert('请先选择一个智能体');
            return;
        }
        
        try {
            const response = await fetch('/api/conversations', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    agent_id: selectedAgentId
                })
            });
            
            if (!response.ok) {
                throw new Error('创建对话失败');
            }
            
            const data = await response.json();
            
            // 切换到新创建的对话
            currentConversationId = data.id;
            chatTitle.textContent = data.title;
            
            // 清空聊天窗口
            clearChatMessages();
            
            // 获取智能体信息并添加欢迎消息
            const agentResponse = await fetch(`/api/agents/${selectedAgentId}`);
            if (agentResponse.ok) {
                const agentData = await agentResponse.json();
                appendMessage(`你好！我是${agentData.name}。${agentData.role ? '我的角色是: ' + agentData.role : ''}`, 'assistant');
            } else {
                appendMessage(`你好！我是你的AI助手。`, 'assistant');
            }
            
            // 重新加载历史记录
            await loadHistory();
            
            // 关闭弹窗
            modal.style.display = 'none';
            
            // 重置选择状态
            selectedAgentId = null;
            
        } catch (error) {
            alert('创建对话失败: ' + error.message);
            console.error('创建对话错误:', error);
        }
    }
    
    /**
     * 删除智能体
     */
    async function deleteAgent(agentId, agentName) {
        if (!confirm(`确定要删除智能体"${agentName}"吗？与该智能体相关的所有对话也将被删除。此操作不可撤销。`)) {
            return;
        }
        
        try {
            const response = await fetch(`/api/agents/${agentId}`, {
                method: 'DELETE'
            });
            
            if (!response.ok) {
                throw new Error('删除智能体失败');
            }
            
            const data = await response.json();
            
            // 显示成功消息
            alert(`智能体"${agentName}"删除成功，同时删除了${data.deleted_conversations}个相关对话。`);
            
            // 如果当前对话是与该智能体相关的，清空聊天窗口
            const currentConvData = await getCurrentConversationData();
            if (currentConvData && currentConvData.agent_id === agentId) {
                currentConversationId = null;
                clearChatMessages();
                chatTitle.textContent = '新对话';
                
                // 添加欢迎信息
                const welcomeMessage = document.createElement('div');
                welcomeMessage.classList.add('message', 'welcome');
                welcomeMessage.innerHTML = '<p>欢迎使用智能问答助手！<br>请从左侧选择一个对话，或点击"新建对话"开始。</p>';
                chatMessages.appendChild(welcomeMessage);
            }
            
            // 重新加载智能体列表
            loadAgentList();
            
            // 重新加载历史记录
            await loadHistory();
            
        } catch (error) {
            console.error('删除智能体错误:', error);
            alert('删除智能体失败: ' + error.message);
        }
    }
    
    /**
     * 获取当前对话数据
     */
    async function getCurrentConversationData() {
        if (!currentConversationId) return null;
        
        try {
            const response = await fetch(`/api/conversations/${currentConversationId}`);
            if (!response.ok) return null;
            return await response.json();
        } catch (e) {
            console.error('获取当前对话数据出错:', e);
            return null;
        }
    }
    
    // --- 功能函数 ---

    /**
     * 加载并显示历史对话列表
     */
    async function loadHistory() {
        try {
            const response = await fetch('/api/conversations');
            if (!response.ok) {
                throw new Error('获取历史记录失败');
            }
            
            const conversations = await response.json();
            
            // 清空历史列表
            historyList.innerHTML = '';
            
            // 添加每个对话到列表
            conversations.forEach(conv => {
                const historyItem = document.createElement('div');
                historyItem.classList.add('history-item');
                historyItem.dataset.id = conv.id;
                
                // 创建标题元素
                const titleSpan = document.createElement('span');
                titleSpan.classList.add('title');
                titleSpan.textContent = conv.title;
                historyItem.appendChild(titleSpan);
                
                // 创建删除按钮
                const deleteBtn = document.createElement('button');
                deleteBtn.classList.add('delete-btn');
                deleteBtn.innerHTML = '&times;';
                deleteBtn.title = '删除对话';
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation(); // 阻止事件冒泡，避免触发对话切换
                    deleteConversation(conv.id);
                });
                historyItem.appendChild(deleteBtn);
                
                // 如果是当前对话，标记为活跃
                if (conv.id === currentConversationId) {
                    historyItem.classList.add('active');
                }
                
                // 点击切换到该对话
                historyItem.addEventListener('click', () => switchConversation(conv.id));
                
                historyList.appendChild(historyItem);
            });
        } catch (error) {
            console.error('加载历史记录错误:', error);
        }
    }

    /**
     * 切换到指定对话
     */
    async function switchConversation(conversationId) {
        if (conversationId === currentConversationId) return;
        
        try {
            const response = await fetch(`/api/conversations/${conversationId}`);
            if (!response.ok) {
                throw new Error('获取对话失败');
            }
            
            const conversation = await response.json();
            
            // 更新当前对话ID
            currentConversationId = conversationId;
            
            // 更新标题
            chatTitle.textContent = conversation.title;
            
            // 清空聊天窗口
            clearChatMessages();
            
            // 加载消息历史
            conversation.messages.forEach(msg => {
                appendMessage(msg.content, msg.role);
            });
            
            // 更新历史列表中的活跃项
            document.querySelectorAll('.history-item').forEach(item => {
                item.classList.toggle('active', item.dataset.id === conversationId);
            });

            // 更新对话控制按钮的显示状态
            updateChatControls();

        } catch (error) {
            console.error('切换对话错误:', error);
            alert('切换对话失败: ' + error.message);
        }
    }

    /**
     * 处理消息中的LaTeX公式，确保正确显示
     */
    function processLatexFormulas(text) {
        // 处理行内公式：将 \(formula\) 确保正确格式化
        text = text.replace(/\\\((.*?)\\\)/g, function(match, formula) {
            return '\\(' + formula + '\\)';
        });
        
        // 处理行间公式：将 \[formula\] 确保正确格式化
        text = text.replace(/\\\[(.*?)\\\]/g, function(match, formula) {
            return '\\[' + formula + '\\]';
        });
        
        return text;
    }
    
    async function sendMessage() {
        const messageText = userInput.value.trim();
        if (!messageText || isProcessingMessage) return;

        if (!currentConversationId) {
            alert("请先从左侧选择一个对话，或新建一个对话。");
            return;
        }

        // 添加用户消息到界面
        appendMessage(messageText, 'user');
        
        // 清空输入框
        userInput.value = '';
        userInput.style.height = 'auto';
        
        // 标记为正在处理
        isProcessingMessage = true;
        sendBtn.disabled = true;
        
        try {
            // 发送消息到后端
            const response = await fetch(`/api/conversations/${currentConversationId}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: messageText
                })
            });
            
            if (!response.ok) {
                throw new Error('发送消息失败');
            }
            
            const data = await response.json();
            
            // 显示AI回复
            appendMessage(data.message.content, 'assistant');
            
        } catch (error) {
            console.error('发送消息错误:', error);
            appendMessage('发送消息失败: ' + error.message, 'system');
        } finally {
            // 恢复状态
            isProcessingMessage = false;
            sendBtn.disabled = false;
        }
    }
    
    /**
     * 在聊天中添加消息
     * @param {string} text - 消息文本
     * @param {string} sender - 发送者类型 ('user' 或 'assistant')
     */
    function appendMessage(text, sender) {
        // 创建消息元素
        const messageEl = document.createElement('div');
        messageEl.classList.add('message');
        
        if (sender === 'user') {
            messageEl.classList.add('user');
            // 处理LaTeX公式
            const processedText = processLatexFormulas(text);
            messageEl.innerHTML = `<p>${processedText}</p>`;
        } 
        else if (sender === 'assistant') {
            messageEl.classList.add('assistant');
            
            // 检查是否为转发的消息
            if (text.includes('[') && text.includes('回答]')) {
                // 提取原始智能体名称和转发智能体名称
                const forwardPattern = /\[(.*?)回答\]/;
                const match = text.match(forwardPattern);
                
                if (match && match[1]) {
                    const forwardAgentName = match[1];
                    const cleanText = text.replace(forwardPattern, '').trim();
                    
                    // 使用特殊样式显示转发消息
                    messageEl.classList.add('forwarded');
                    // 处理LaTeX公式
                    const processedText = processLatexFormulas(cleanText);
                    messageEl.innerHTML = `
                        <div class="forward-header">
                            <span class="forward-agent">${forwardAgentName} 回答:</span>
                        </div>
                        <p>${processedText}</p>
                    `;
                } else {
                    const processedText = processLatexFormulas(text);
                    messageEl.innerHTML = `<p>${processedText}</p>`;
                }
            } else {
                const processedText = processLatexFormulas(text);
                messageEl.innerHTML = `<p>${processedText}</p>`;
            }
        } 
        else if (sender === 'user-thinking') {
            messageEl.classList.add('user-thinking');
            const processedText = processLatexFormulas(text);
            messageEl.innerHTML = `<p>${processedText}</p><div class="thinking-dots"><div></div><div></div><div></div></div>`;
        } 
        else if (sender === 'assistant-thinking') {
            messageEl.classList.add('assistant-thinking');
            const processedText = processLatexFormulas(text);
            messageEl.innerHTML = `<p>${processedText}</p><div class="thinking-dots"><div></div><div></div><div></div></div>`;
        }
        
        // 添加到聊天区域
        chatMessages.appendChild(messageEl);
        
        // 渲染数学公式
        if (window.MathJax && (sender === 'user' || sender === 'assistant')) {
            window.MathJax.typesetPromise([messageEl]).catch((err) => console.error('MathJax error:', err));
        }
        
        // 滚动到底部
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    /**
     * 将文本分段，确保每段不超过最大长度，且在句子边界处分割
     */
    function splitTextIntoChunks(text, maxChunkLength = 300) {
        // 如果文本长度不超过最大长度，直接返回
        if (text.length <= maxChunkLength) {
            return [text];
        }
        
        // 句子结束标记
        const sentenceEndings = ['.', '!', '?', '。', '！', '？', '\n\n'];
        const chunks = [];
        let startIndex = 0;
        
        while (startIndex < text.length) {
            // 计算理想的结束位置
            let endIndex = Math.min(startIndex + maxChunkLength, text.length);
            
            // 如果没有到达文本末尾，尝试找到合适的句子边界
            if (endIndex < text.length) {
                // 从理想位置向前查找句子结束标记
                let boundaryFound = false;
                
                // 向后查找100个字符，寻找句子结束标记
                for (let i = 0; i < 100 && endIndex - i > startIndex; i++) {
                    const charPos = endIndex - i;
                    if (sentenceEndings.includes(text[charPos - 1])) {
                        endIndex = charPos;
                        boundaryFound = true;
                        break;
                    }
                }
                
                // 如果向后找不到，向前找最近的句子结束标记
                if (!boundaryFound) {
                    for (let i = 0; i < 100 && endIndex + i < text.length; i++) {
                        const charPos = endIndex + i;
                        if (sentenceEndings.includes(text[charPos])) {
                            endIndex = charPos + 1; // 包含句子结束标记
                            break;
                        }
                    }
                }
            }
            
            // 添加当前块
            chunks.push(text.substring(startIndex, endIndex));
            
            // 更新起始位置
            startIndex = endIndex;
        }
        
        return chunks;
    }

    /**
     * 清空聊天窗口
     */
    function clearChatMessages() {
        chatMessages.innerHTML = '';
    }

    /**
     * 删除指定对话
     */
    async function deleteConversation(conversationId) {
        if (!confirm('确定要删除这个对话吗？此操作不可撤销。')) {
            return;
        }
        
        try {
            const response = await fetch(`/api/conversations/${conversationId}`, {
                method: 'DELETE'
            });
            
            if (!response.ok) {
                throw new Error('删除对话失败');
            }
            
            // 如果删除的是当前对话，清空聊天窗口
            if (conversationId === currentConversationId) {
                currentConversationId = null;
                clearChatMessages();
                chatTitle.textContent = '新对话';
                
                // 添加欢迎信息
                const welcomeMessage = document.createElement('div');
                welcomeMessage.classList.add('message', 'welcome');
                welcomeMessage.innerHTML = '<p>欢迎使用智能问答助手！<br>请从左侧选择一个对话，或点击"新建对话"开始。</p>';
                chatMessages.appendChild(welcomeMessage);
            }
            
            // 重新加载历史记录
            await loadHistory();
            
        } catch (error) {
            console.error('删除对话错误:', error);
            alert('删除对话失败: ' + error.message);
        }
    }

    /**
     * 打开语音输入弹窗
     */
    function openVoiceInputModal() {
        // 重置语音输入状态
        recordingIndicator.style.display = 'none';
        voiceResult.style.display = 'none';
        voiceTextResult.textContent = '';
        useVoiceTextBtn.disabled = true;
        startRecordingBtn.disabled = false;
        stopRecordingBtn.disabled = true;
        
        // 显示弹窗
        voiceInputModal.style.display = 'block';
    }

    /**
     * 开始录音
     */
    async function startRecording() {
        try {
            // 获取麦克风权限
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            
            // 创建媒体记录器
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            // 收集音频数据
            mediaRecorder.ondataavailable = (event) => {
                audioChunks.push(event.data);
            };
            
            // 录音结束后处理
            mediaRecorder.onstop = async () => {
                // 停止所有轨道
                stream.getTracks().forEach(track => track.stop());
                
                // 处理录音数据
                if (audioChunks.length > 0) {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    
                    // 显示处理中状态
                    voiceTextResult.textContent = '正在处理语音...';
                    voiceResult.style.display = 'block';
                    
                    try {
                        // 创建表单数据
                        const formData = new FormData();
                        formData.append('audio', audioBlob, 'recording.webm');
                        
                        // 发送到后端进行语音识别
                        const response = await fetch('/api/speech-to-text', {
                            method: 'POST',
                            body: formData
                        });
                        
                        if (!response.ok) {
                            throw new Error('语音识别失败');
                        }
                        
                        const data = await response.json();
                        
                        // 显示识别结果
                        voiceTextResult.textContent = data.text || '未能识别语音';
                        useVoiceTextBtn.disabled = !data.text;
                        
                    } catch (error) {
                        console.error('语音识别错误:', error);
                        voiceTextResult.textContent = '语音识别出错: ' + error.message;
                    }
                }
            };
            
            // 开始录音
            mediaRecorder.start();
            
            // 更新UI状态
            recordingIndicator.style.display = 'block';
            startRecordingBtn.disabled = true;
            stopRecordingBtn.disabled = false;
            
        } catch (error) {
            console.error('获取麦克风权限错误:', error);
            alert('无法访问麦克风: ' + error.message);
        }
    }

    /**
     * 停止录音
     */
    function stopRecording() {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
            recordingIndicator.style.display = 'none';
            startRecordingBtn.disabled = false;
            stopRecordingBtn.disabled = true;
        }
    }

    /**
     * 使用语音识别的文本
     */
    function useVoiceText() {
        const text = voiceTextResult.textContent;
        if (text) {
            userInput.value = text;
            voiceInputModal.style.display = 'none';
            userInput.focus();
        }
    }

    /**
     * 自动调整文本输入框高度
     */
    userInput.addEventListener('input', () => {
        userInput.style.height = 'auto';
        userInput.style.height = (userInput.scrollHeight) + 'px';
    });

    // --- 初始化 ---
    loadHistory();

    // 语音通话功能
    function startVoiceCall() {
        if (isVoiceCallActive) return;
        
        isVoiceCallActive = true;
        voiceCallBtn.classList.add('active');
        voiceCallBtn.innerHTML = '<i class="fas fa-phone"></i> 结束通话';
        
        // 添加麦克风控制按钮
        const micControlBtn = document.createElement('button');
        micControlBtn.id = 'mic-control-btn';
        micControlBtn.className = 'mic-active';
        micControlBtn.innerHTML = '<i class="fas fa-microphone"></i> 关闭麦克风';
        micControlBtn.title = '关闭麦克风';
        micControlBtn.onclick = toggleMicrophone;
        
        // 添加音量可视化组件
        const volumeIndicator = document.createElement('div');
        volumeIndicator.id = 'volume-indicator';
        volumeIndicator.className = 'volume-indicator';
        volumeIndicator.innerHTML = `
            <div class="volume-meter">
                <div class="volume-level" id="volume-level"></div>
            </div>
            <div class="voice-status" id="voice-status">等待说话...</div>
        `;
        
        // 将按钮和音量指示器添加到UI中
        const chatHeader = document.querySelector('.chat-header');
        // 检查是否已存在
        if (!document.getElementById('mic-control-btn')) {
            chatHeader.appendChild(micControlBtn);
        }
        if (!document.getElementById('volume-indicator')) {
            chatHeader.appendChild(volumeIndicator);
        }
        
        // 显示通话状态指示
        appendSystemMessage("语音通话已开始，请说话...");
        
        // 麦克风默认开启
        isMicrophoneActive = true;
        
        // 开始录音
        startVoiceCallRecording();
    }

    function stopVoiceCall() {
        if (!isVoiceCallActive) return;
        
        isVoiceCallActive = false;
        voiceCallBtn.classList.remove('active');
        voiceCallBtn.innerHTML = '<i class="fas fa-phone"></i> 语音通话';
        
        // 停止录音
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        }
        
        // 停止AI语音播放
        if (currentlyPlayingAudio) {
            currentlyPlayingAudio.pause();
            currentlyPlayingAudio = null;
            isAISpeaking = false;
        }
        
        // 停止计时器
        if (voiceCallTimer) {
            clearTimeout(voiceCallTimer);
            voiceCallTimer = null;
        }
        
        // 停止静音检测
        if (silenceDetector) {
            cancelAnimationFrame(silenceDetector);
            silenceDetector = null;
        }
        
        // 停止所有媒体轨道
        if (currentMediaStream) {
            currentMediaStream.getTracks().forEach(track => track.stop());
            currentMediaStream = null;
        }
        
        // 移除麦克风控制按钮
        const micControlBtn = document.getElementById('mic-control-btn');
        if (micControlBtn) {
            micControlBtn.remove();
        }
        
        // 移除音量指示器
        const volumeIndicator = document.getElementById('volume-indicator');
        if (volumeIndicator) {
            volumeIndicator.remove();
        }
        
        appendSystemMessage("语音通话已结束");
    }

    async function startVoiceCallRecording() {
        // 如果麦克风已关闭，则不启动录音
        if (!isMicrophoneActive) return;
        
        try {
            // 获取麦克风权限
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            // 保存流的引用，方便后续关闭
            currentMediaStream = stream;
            
            // 创建音频上下文用于静音检测
            const audioContext = new AudioContext();
            const audioSource = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            
            audioSource.connect(analyser);
            
            // 创建媒体记录器
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            
            let silenceStart = null;
            let isSpeaking = false;
            let recordingStartTime = null;
            
            // 修改checkSilence函数来更新音量可视化
            const checkSilence = () => {
                if (!isVoiceCallActive || !isMicrophoneActive) {
                    return;
                }
                
                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteFrequencyData(dataArray);
                
                // 计算音量
                const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
                const normalizedValue = average / 255; // 0-1范围
                
                // 更新音量指示器
                updateVolumeIndicator(normalizedValue);
                
                // 原有的音量检测逻辑
                if (normalizedValue > MIN_VOLUME_THRESHOLD) {
                    // 有足够大的声音
                    
                    // 检查是否需要打断AI
                    if (isAISpeaking) {
                        interruptAISpeech();
                    }
                    
                    if (!isSpeaking) {
                        isSpeaking = true;
                        // 记录开始时间
                        recordingStartTime = Date.now();
                        if (!mediaRecorder || mediaRecorder.state === 'inactive') {
                            // 开始新录音
                            mediaRecorder.start();
                            audioChunks = [];
                            // 更新状态显示
                            updateVoiceStatus("正在录音...", true);
                        }
                    }
                    silenceStart = null;
                } else if (isSpeaking) {
                    // 静音开始
                    if (silenceStart === null) {
                        silenceStart = Date.now();
                        // 更新状态显示
                        updateVoiceStatus("检测到停顿...", false);
                    } else if (Date.now() - silenceStart > SILENCE_DURATION) {
                        // 静音持续超过阈值，结束这段录音并处理
                        const recordingDuration = Date.now() - recordingStartTime;
                        isSpeaking = false;
                        
                        // 更新状态显示
                        updateVoiceStatus("处理中...", false);
                        
                        // 检查录音时长是否够长
                        if (recordingDuration < MIN_RECORDING_DURATION) {
                            console.log("录音时长过短，忽略此次输入");
                            // 重置录音但不处理
                            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                                mediaRecorder.stop();
                            }
                            // 不处理这段录音，显示提示
                            appendSystemMessage("声音过短，请重新说话...");
                            // 更新状态显示
                            updateVoiceStatus("等待说话...", false);
                            return;
                        }
                        
                        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                            mediaRecorder.stop();
                        }
                    }
                } else {
                    // 未说话状态
                    updateVoiceStatus("等待说话...", false);
                }
                
                // 继续检测
                silenceDetector = requestAnimationFrame(checkSilence);
            };
            
            // 开始静音检测
            silenceDetector = requestAnimationFrame(checkSilence);
            
            // 收集音频数据
            mediaRecorder.ondataavailable = (event) => {
                audioChunks.push(event.data);
            };
            
            // 录音结束后处理
            mediaRecorder.onstop = async () => {
                if (audioChunks.length > 0) {
                    // 更新状态显示
                    updateVoiceStatus("识别中...", false);
                    
                    // 显示用户正在说话状态
                    appendMessage("正在处理您的语音...", "user-thinking");
                    
                    // 处理录音
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const formData = new FormData();
                    formData.append('audio', audioBlob, 'recording.webm');
                    
                    try {
                        // 发送到后端进行语音识别
                        const response = await fetch('/api/speech-to-text', {
                            method: 'POST',
                            body: formData
                        });
                        
                        if (!response.ok) {
                            throw new Error('语音识别失败');
                        }
                        
                        const data = await response.json();
                        const recognizedText = data.text ? data.text.trim() : '';
                        
                        // 检查识别结果是否有意义
                        const isTextMeaningless = recognizedText.length < MIN_SPEECH_LENGTH || 
                            MEANINGLESS_PATTERNS.some(pattern => pattern.test(recognizedText));
                        
                        if (recognizedText && !isTextMeaningless) {
                            // 移除"正在处理"消息
                            removeUserThinkingMessage();
                            
                            // 显示用户消息
                            appendMessage(recognizedText, 'user');
                            
                            // 发送到AI并获取回复
                            await processVoiceMessage(recognizedText);
                        } else {
                            removeUserThinkingMessage();
                            // 显示提示信息
                            appendSystemMessage("未能识别有效语音，请重新说话...");
                        }
                    } catch (error) {
                        console.error('语音识别错误:', error);
                        removeUserThinkingMessage();
                        appendSystemMessage("语音识别出错，请重试");
                    }
                    
                    // 识别完成后更新状态
                    updateVoiceStatus("等待说话...", false);
                    
                    // 准备新一轮录音
                    audioChunks = [];
                }
            };
            
        } catch (error) {
            console.error('获取麦克风权限错误:', error);
            appendSystemMessage("无法访问麦克风，语音通话已取消");
            stopVoiceCall();
        }
    }

    async function processVoiceMessage(text) {
        if (!currentConversationId) {
            appendSystemMessage("请先选择或创建一个对话");
            return;
        }
        
        // 显示AI思考状态
        appendMessage("正在思考...", "assistant-thinking");
        
        try {
            // 发送消息到后端
            const response = await fetch(`/api/conversations/${currentConversationId}/messages`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    message: text
                })
            });
            
            if (!response.ok) {
                throw new Error('获取回复失败');
            }
            
            const data = await response.json();
            
            // 移除"思考中"消息
            removeAssistantThinkingMessage();
            
            // 显示AI回复
            const aiMessage = data.message;
            appendMessage(aiMessage.content, 'assistant');
            
            // 自动播放语音回复
            if (isVoiceCallActive) {
                try {
                    // 使用支持打断的语音播放
                    await playAIResponseWithInterruption(aiMessage.content);
                } catch (error) {
                    console.error('播放语音错误:', error);
                    appendSystemMessage("播放语音出错，请继续说话...");
                }
            }
        } catch (error) {
            console.error('处理消息错误:', error);
            removeAssistantThinkingMessage();
            appendSystemMessage("获取回复失败，请重试");
        }
    }

    // 添加辅助函数显示系统消息
    function appendSystemMessage(text) {
        const systemMessage = document.createElement('div');
        systemMessage.classList.add('message', 'system');
        systemMessage.innerHTML = `<p>${text}</p>`;
        chatMessages.appendChild(systemMessage);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function removeUserThinkingMessage() {
        const thinkingMessages = document.querySelectorAll('.message.user-thinking');
        thinkingMessages.forEach(msg => msg.remove());
    }

    function removeAssistantThinkingMessage() {
        const thinkingMessages = document.querySelectorAll('.message.assistant-thinking');
        thinkingMessages.forEach(msg => msg.remove());
    }

    // 添加切换函数
    function toggleVoiceCall() {
        if (isVoiceCallActive) {
            stopVoiceCall();
        } else {
            startVoiceCall();
        }
    }

    // 修改语音通话播放语音的部分，使其可被打断
    async function playAIResponseWithInterruption(text) {
        // 如果有正在播放的音频，先停止
        if (currentlyPlayingAudio) {
            interruptAISpeech();
        }
        
        // 更新全局状态
        const prevIsAISpeaking = isAISpeaking;
        
        try {
            // 添加播放状态指示器
            const statusElement = document.createElement('div');
            statusElement.classList.add('ai-speaking-status');
            statusElement.style.color = '#2196F3';
            statusElement.style.fontSize = '12px';
            statusElement.style.marginTop = '5px';
            statusElement.innerHTML = '<i class="fas fa-volume-up"></i> 正在播放语音...';
            
            // 找到最后一条AI消息并添加状态指示器
            const messages = document.querySelectorAll('.message.assistant');
            if (messages.length > 0) {
                const lastMessage = messages[messages.length - 1];
                lastMessage.appendChild(statusElement);
            }
            
            // 将长文本分段
            const textChunks = splitTextIntoChunks(text);
            const totalChunks = textChunks.length;
            
            // 如果分段后超过3段，分段处理
            if (totalChunks > 3) {
                // 创建音频元素数组
                const audioElements = [];
                
                // 按顺序处理每个文本段
                for (let i = 0; i < totalChunks; i++) {
                    try {
                        // 更新状态指示器
                        if (statusElement) {
                            statusElement.innerHTML = `<i class="fas fa-volume-up"></i> 正在处理语音 (${i+1}/${totalChunks})`;
                        }
                        
                        // 获取当前段的语音数据
                        const ttsResponse = await fetch('/api/text-to-speech', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json'
                            },
                            body: JSON.stringify({
                                text: textChunks[i]
                            })
                        });
                        
                        if (!ttsResponse.ok) {
                            const errorData = await ttsResponse.json();
                            throw new Error(errorData.error || `处理第${i+1}段失败`);
                        }
                        
                        // 获取音频blob
                        const audioBlob = await ttsResponse.blob();
                        
                        // 检查blob是否有效
                        if (audioBlob.size === 0) {
                            throw new Error(`第${i+1}段获取到的音频数据为空`);
                        }
                        
                        const audioUrl = URL.createObjectURL(audioBlob);
                        
                        // 创建音频元素
                        const audio = new Audio(audioUrl);
                        audioElements.push({
                            audio: audio,
                            url: audioUrl
                        });
                    } catch (chunkError) {
                        console.error(`处理第${i+1}段出错:`, chunkError);
                        // 继续处理下一段
                    }
                    
                    // 如果用户已经打断播放或语音通话已停止，中止处理
                    if (!isVoiceCallActive || !isAISpeaking) {
                        // 清理已创建的资源
                        audioElements.forEach(item => URL.revokeObjectURL(item.url));
                        
                        // 移除状态指示器
                        if (statusElement && statusElement.parentNode) {
                            statusElement.parentNode.removeChild(statusElement);
                        }
                        
                        return;
                    }
                }
                
                // 如果没有成功处理任何文本段，抛出错误
                if (audioElements.length === 0) {
                    throw new Error('所有文本段处理失败');
                }
                
                // 设置音频连续播放
                for (let i = 0; i < audioElements.length - 1; i++) {
                    const currentAudio = audioElements[i].audio;
                    const nextAudio = audioElements[i + 1].audio;
                    
                    currentAudio.onended = () => {
                        // 释放当前音频资源
                        URL.revokeObjectURL(audioElements[i].url);
                        
                        // 如果语音通话已停止，不继续播放
                        if (!isVoiceCallActive) {
                            return;
                        }
                        
                        // 播放下一段
                        nextAudio.play().catch(err => {
                            console.error('播放下一段失败:', err);
                            // 出错时继续到下一段
                            if (nextAudio.onended) {
                                nextAudio.onended();
                            }
                        });
                    };
                }
                
                // 最后一段播放完成后的处理
                const lastAudio = audioElements[audioElements.length - 1].audio;
                lastAudio.onended = () => {
                    // 释放最后一段资源
                    URL.revokeObjectURL(audioElements[audioElements.length - 1].url);
                    
                    // 重置状态
                    currentlyPlayingAudio = null;
                    isAISpeaking = false;
                    
                    // 移除状态指示器
                    if (statusElement && statusElement.parentNode) {
                        statusElement.parentNode.removeChild(statusElement);
                    }
                    
                    if (isVoiceCallActive) {
                        appendSystemMessage("请继续说话...");
                    }
                };
                
                // 开始播放第一段
                const firstAudio = audioElements[0].audio;
                currentlyPlayingAudio = firstAudio;
                isAISpeaking = true;
                
                try {
                    await firstAudio.play();
                } catch (playError) {
                    throw new Error(`无法开始播放: ${playError.message}`);
                }
            } else {
                // 使用Edge TTS转换文本为语音
                const ttsResponse = await fetch('/api/text-to-speech', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        text: text
                    })
                });
                
                if (!ttsResponse.ok) {
                    const errorData = await ttsResponse.json();
                    throw new Error(errorData.error || '获取语音失败');
                }
                
                // 获取音频blob
                const audioBlob = await ttsResponse.blob();
                
                // 检查播放是否被取消
                if (!isVoiceCallActive) {
                    if (statusElement && statusElement.parentNode) {
                        statusElement.parentNode.removeChild(statusElement);
                    }
                    return;
                }
                
                // 检查blob是否有效
                if (audioBlob.size === 0) {
                    throw new Error('获取到的音频数据为空');
                }
                
                const audioUrl = URL.createObjectURL(audioBlob);
                
                // 创建音频元素并播放
                const audio = new Audio(audioUrl);
                currentlyPlayingAudio = audio;
                isAISpeaking = true; // 标记AI开始说话
                
                // 更新状态指示器
                if (statusElement) {
                    statusElement.innerHTML = '<i class="fas fa-volume-up"></i> 正在播放...';
                }
                
                // 播放完成后继续录音
                audio.onended = () => {
                    URL.revokeObjectURL(audioUrl);
                    currentlyPlayingAudio = null;
                    isAISpeaking = false; // 标记AI结束说话
                    
                    // 移除状态指示器
                    if (statusElement && statusElement.parentNode) {
                        statusElement.parentNode.removeChild(statusElement);
                    }
                    
                    if (isVoiceCallActive) {
                        appendSystemMessage("请继续说话...");
                    }
                };
                
                // 播放出错时处理
                audio.onerror = (e) => {
                    console.error('播放音频出错:', e);
                    URL.revokeObjectURL(audioUrl);
                    currentlyPlayingAudio = null;
                    isAISpeaking = false; // 标记AI结束说话
                    
                    // 移除状态指示器
                    if (statusElement && statusElement.parentNode) {
                        statusElement.parentNode.removeChild(statusElement);
                    }
                    
                    if (isVoiceCallActive) {
                        appendSystemMessage("播放语音出错，请继续说话...");
                    }
                };
                
                // 开始播放
                try {
                    await audio.play();
                } catch (playError) {
                    throw new Error(`无法播放音频: ${playError.message}`);
                }
            }
            
        } catch (error) {
            console.error('播放语音错误:', error);
            isAISpeaking = prevIsAISpeaking; // 恢复之前的状态
            
            if (isVoiceCallActive) {
                appendSystemMessage(`播放语音出错 (${error.message})，请继续说话...`);
            }
            
            // 移除可能存在的状态指示器
            const statusElements = document.querySelectorAll('.ai-speaking-status');
            statusElements.forEach(el => {
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
            });
        }
    }

    // 添加打断功能
    function interruptAISpeech() {
        if (currentlyPlayingAudio && isAISpeaking) {
            // 停止当前播放
            currentlyPlayingAudio.pause();
            currentlyPlayingAudio.currentTime = 0;
            currentlyPlayingAudio = null;
            isAISpeaking = false;
            
            // 移除可能存在的状态指示器
            const statusElements = document.querySelectorAll('.ai-speaking-status');
            statusElements.forEach(el => {
                if (el.parentNode) {
                    el.parentNode.removeChild(el);
                }
            });
            
            // 显示打断提示
            appendSystemMessage("AI回复已被打断");
            
            return true;
        }
        return false;
    }

    // 切换麦克风状态
    function toggleMicrophone() {
        const micControlBtn = document.getElementById('mic-control-btn');
        if (!micControlBtn) return;
        
        // 切换状态
        isMicrophoneActive = !isMicrophoneActive;
        
        if (isMicrophoneActive) {
            // 打开麦克风
            micControlBtn.className = 'mic-active';
            micControlBtn.innerHTML = '<i class="fas fa-microphone"></i> 关闭麦克风';
            micControlBtn.title = '关闭麦克风';
            
            // 重置音量指示器
            updateVolumeIndicator(0);
            updateVoiceStatus("等待说话...", false);
            
            // 如果语音通话处于激活状态，重新开始录音
            if (isVoiceCallActive) {
                appendSystemMessage("麦克风已开启");
                startVoiceCallRecording();
            }
        } else {
            // 关闭麦克风
            micControlBtn.className = 'mic-inactive';
            micControlBtn.innerHTML = '<i class="fas fa-microphone-slash"></i> 打开麦克风';
            micControlBtn.title = '打开麦克风';
            
            // 更新音量指示器状态
            updateVolumeIndicator(0);
            updateVoiceStatus("麦克风已关闭", false);
            
            // 停止当前录音
            if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                mediaRecorder.stop();
            }
            
            // 关闭所有媒体轨道
            if (currentMediaStream) {
                currentMediaStream.getTracks().forEach(track => track.stop());
                currentMediaStream = null;
            }
            
            appendSystemMessage("麦克风已关闭");
        }
    }

    // 更新音量指示器
    function updateVolumeIndicator(volume) {
        const volumeLevel = document.getElementById('volume-level');
        if (volumeLevel) {
            // 设置宽度以显示音量大小 (0-100%)
            const percentage = Math.min(100, Math.round(volume * 100));
            volumeLevel.style.width = `${percentage}%`;
            
            // 当音量超过阈值时改变颜色
            if (volume > MIN_VOLUME_THRESHOLD) {
                volumeLevel.classList.add('threshold-met');
            } else {
                volumeLevel.classList.remove('threshold-met');
            }
        }
    }

    // 更新语音状态文本
    function updateVoiceStatus(status, isActive) {
        const voiceStatus = document.getElementById('voice-status');
        if (voiceStatus) {
            voiceStatus.textContent = status;
            if (isActive) {
                voiceStatus.classList.add('active');
            } else {
                voiceStatus.classList.remove('active');
            }
        }
    }

    // --- 对话上下文管理功能 ---

    /**
     * 刷新对话上下文
     */
    async function refreshConversationContext() {
        if (!currentConversationId) {
            alert('请先选择一个对话');
            return;
        }

        try {
            refreshContextBtn.disabled = true;
            refreshContextBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 刷新中...';

            const response = await fetch(`/api/conversations/${currentConversationId}/refresh-context`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });

            const result = await response.json();

            if (result.success) {
                // 显示成功消息
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message system';
                messageDiv.innerHTML = `
                    <div class="message-content">
                        <p><i class="fas fa-sync-alt"></i> 对话上下文已刷新，AI已重新加载 ${result.message_count} 条历史消息</p>
                    </div>
                `;
                chatMessages.appendChild(messageDiv);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            } else {
                alert('刷新上下文失败: ' + result.error);
            }
        } catch (error) {
            console.error('刷新上下文错误:', error);
            alert('刷新上下文时发生错误');
        } finally {
            refreshContextBtn.disabled = false;
            refreshContextBtn.innerHTML = '<i class="fas fa-sync-alt"></i> 刷新记忆';
        }
    }

    /**
     * 显示记忆状态
     */
    async function showMemoryStatus() {
        if (!currentConversationId) {
            alert('请先选择一个对话');
            return;
        }

        try {
            const response = await fetch(`/api/conversations/${currentConversationId}/memory-status`);
            const memoryInfo = await response.json();

            if (response.ok) {
                const statusMessage = `
                    <div class="memory-status">
                        <h4><i class="fas fa-brain"></i> 对话记忆状态</h4>
                        <p><strong>对话ID:</strong> ${memoryInfo.conversation_id}</p>
                        <p><strong>智能体:</strong> ${memoryInfo.agent_name}</p>
                        <p><strong>总消息数:</strong> ${memoryInfo.total_messages}</p>
                        <p><strong>QA链状态:</strong> ${memoryInfo.qa_chain_loaded ? '已加载' : '未加载'}</p>
                        <p><strong>记忆状态:</strong> ${memoryInfo.has_memory ? '正常' : '异常'}</p>
                        ${memoryInfo.memory_messages_count ? `<p><strong>记忆中消息数:</strong> ${memoryInfo.memory_messages_count}</p>` : ''}
                        ${memoryInfo.memory_type ? `<p><strong>记忆类型:</strong> ${memoryInfo.memory_type}</p>` : ''}
                        ${memoryInfo.memory_error ? `<p><strong>记忆错误:</strong> ${memoryInfo.memory_error}</p>` : ''}
                    </div>
                `;

                // 显示状态信息
                const messageDiv = document.createElement('div');
                messageDiv.className = 'message system';
                messageDiv.innerHTML = `<div class="message-content">${statusMessage}</div>`;
                chatMessages.appendChild(messageDiv);
                chatMessages.scrollTop = chatMessages.scrollHeight;
            } else {
                alert('获取记忆状态失败: ' + memoryInfo.error);
            }
        } catch (error) {
            console.error('获取记忆状态错误:', error);
            alert('获取记忆状态时发生错误');
        }
    }

    /**
     * 更新对话控制按钮的显示状态
     */
    function updateChatControls() {
        if (currentConversationId) {
            refreshContextBtn.style.display = 'inline-block';
            memoryStatusBtn.style.display = 'inline-block';
        } else {
            refreshContextBtn.style.display = 'none';
            memoryStatusBtn.style.display = 'none';
        }
    }

    // 在页面关闭前清理资源
    window.addEventListener('beforeunload', () => {
        if (currentMediaStream) {
            currentMediaStream.getTracks().forEach(track => track.stop());
        }
        if (currentlyPlayingAudio) {
            currentlyPlayingAudio.pause();
        }
    });
});