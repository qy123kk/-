from flask import Flask, render_template, request, jsonify, session, send_file, Response, stream_with_context
from flask_socketio import SocketIO, emit
import os
import json
import uuid
import time
import shutil
import rag_core
import io
import speech_to_text
import text_to_speech
from werkzeug.utils import secure_filename
import threading
import asyncio
import base64
import edge_tts

app = Flask(__name__)
app.secret_key = os.urandom(24)  # 用于session
socketio = SocketIO(app, cors_allowed_origins="*")  # 添加WebSocket支持

# --- 配置 ---
UPLOAD_FOLDER = 'uploads'
VECTOR_STORE_FOLDER = 'vector_stores'
AGENTS_FOLDER = 'agents'
CONVERSATIONS_FOLDER = 'conversations'

# 智能体类型定义
AGENT_TYPES = {
    "DEFAULT": "通用智能体",
    "CHINESE_TEACHER": "语文老师",
    "MATH_TEACHER": "数学老师"
}

# 确保所有必要的文件夹都存在
for folder in [UPLOAD_FOLDER, VECTOR_STORE_FOLDER, AGENTS_FOLDER, CONVERSATIONS_FOLDER]:
    os.makedirs(folder, exist_ok=True)

# 允许上传的文件类型
ALLOWED_EXTENSIONS = {'pdf', 'docx', 'txt'}

# --- 内存中的状态 (临时方案) ---
# 在生产环境中，应该使用数据库来存储
agents = {}  # {agent_id: agent_info}
conversations = {}  # {conv_id: {qa_chain, agent_id, messages}}

# --- 辅助函数 ---

def allowed_file(filename):
    """检查文件类型是否允许上传"""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def load_agents():
    """从文件系统加载所有已保存的智能体"""
    global agents
    if not os.path.exists(AGENTS_FOLDER):
        return
    
    for agent_id in os.listdir(AGENTS_FOLDER):
        agent_path = os.path.join(AGENTS_FOLDER, agent_id)
        if os.path.isdir(agent_path):
            info_path = os.path.join(agent_path, 'info.json')
            if os.path.exists(info_path):
                with open(info_path, 'r', encoding='utf-8') as f:
                    agents[agent_id] = json.load(f)

def load_conversations():
    """从文件系统加载所有已保存的对话"""
    global conversations
    if not os.path.exists(CONVERSATIONS_FOLDER):
        return
    
    for conv_id in os.listdir(CONVERSATIONS_FOLDER):
        conv_path = os.path.join(CONVERSATIONS_FOLDER, conv_id)
        if os.path.isdir(conv_path):
            messages_path = os.path.join(conv_path, 'messages.json')
            info_path = os.path.join(conv_path, 'info.json')
            if os.path.exists(messages_path) and os.path.exists(info_path):
                with open(messages_path, 'r', encoding='utf-8') as f:
                    messages = json.load(f)
                with open(info_path, 'r', encoding='utf-8') as f:
                    info = json.load(f)
                
                # 创建对话对象但不立即加载QA链（延迟加载）
                conversations[conv_id] = {
                    'qa_chain': None,  # 延迟加载
                    'agent_id': info['agent_id'],
                    'messages': messages,
                    'title': info.get('title', '新对话')
                }

def save_agent(agent_id, agent_info):
    """保存智能体信息到文件系统"""
    agent_path = os.path.join(AGENTS_FOLDER, agent_id)
    os.makedirs(agent_path, exist_ok=True)
    
    # 保存智能体信息
    with open(os.path.join(agent_path, 'info.json'), 'w', encoding='utf-8') as f:
        json.dump(agent_info, f, ensure_ascii=False, indent=2)

def save_conversation(conv_id):
    """保存对话到文件系统"""
    if conv_id not in conversations:
        return
    
    conv_data = conversations[conv_id]
    conv_path = os.path.join(CONVERSATIONS_FOLDER, conv_id)
    os.makedirs(conv_path, exist_ok=True)
    
    # 保存消息
    with open(os.path.join(conv_path, 'messages.json'), 'w', encoding='utf-8') as f:
        json.dump(conv_data['messages'], f, ensure_ascii=False, indent=2)
    
    # 保存对话信息
    info = {
        'agent_id': conv_data['agent_id'],
        'title': conv_data.get('title', '新对话'),
        'created_at': conv_data.get('created_at', time.time())
    }
    with open(os.path.join(conv_path, 'info.json'), 'w', encoding='utf-8') as f:
        json.dump(info, f, ensure_ascii=False, indent=2)

def get_qa_chain(conv_id):
    """获取对话的QA链，如果需要则创建，支持对话历史恢复"""
    if conv_id not in conversations:
        return None

    conv_data = conversations[conv_id]

    # 如果QA链已经存在，直接返回
    if conv_data['qa_chain'] is not None:
        return conv_data['qa_chain']

    # 否则，创建新的QA链
    agent_id = conv_data['agent_id']
    if agent_id not in agents:
        return None

    agent_info = agents[agent_id]
    vector_store_path = os.path.join(VECTOR_STORE_FOLDER, agent_id)

    # 获取对话历史用于上下文恢复
    conversation_history = conv_data.get('messages', [])

    # 如果向量存储存在，加载它
    if os.path.exists(vector_store_path):
        try:
            vector_store = rag_core.load_vector_store(vector_store_path)
            # 使用增强的QA链创建方法，传入对话历史
            qa_chain, _ = rag_core.create_enhanced_qa_chain_with_context(
                vector_store,
                agent_info.get('role', '你是一个有用的AI助手。'),
                conversation_history
            )
            conv_data['qa_chain'] = qa_chain
            return qa_chain
        except Exception as e:
            print(f"加载QA链时出错: {e}")
            return None
    else:
        # 如果没有知识库，创建一个空的QA链
        try:
            from langchain_community.vectorstores import FAISS
            from langchain_community.embeddings import DashScopeEmbeddings
            from langchain.schema import Document

            api_key = os.getenv("DASHSCOPE_API_KEY", "sk-ea76fba3b52045579e38a398598ff512")
            embeddings = DashScopeEmbeddings(
                model="text-embedding-v1",
                dashscope_api_key=api_key
            )

            # 创建一个空的向量存储
            empty_docs = [Document(page_content="这是一个空的知识库", metadata={"source": "none"})]
            vector_store = FAISS.from_documents(empty_docs, embeddings)

            # 使用增强的QA链创建方法，传入对话历史
            qa_chain, _ = rag_core.create_enhanced_qa_chain_with_context(
                vector_store,
                agent_info.get('role', '你是一个有用的AI助手。'),
                conversation_history
            )
            conv_data['qa_chain'] = qa_chain
            return qa_chain
        except Exception as e:
            print(f"创建空QA链时出错: {e}")
            return None

def refresh_qa_chain_context(conv_id):
    """刷新QA链的上下文，用于长对话中保持记忆"""
    if conv_id not in conversations:
        return False

    conv_data = conversations[conv_id]
    agent_id = conv_data['agent_id']

    if agent_id not in agents:
        return False

    # 强制重新创建QA链以更新上下文
    conv_data['qa_chain'] = None

    # 重新获取QA链，这会自动加载最新的对话历史
    qa_chain = get_qa_chain(conv_id)

    return qa_chain is not None

# --- 智能体意图识别与消息路由 ---

def detect_intent(message):
    """
    检测用户消息的意图，判断是语文问题还是数学问题
    返回意图类型: "CHINESE_TEACHER" 或 "MATH_TEACHER"
    """
    # 数学问题的特征词
    math_keywords = [
        "数学", "计算", "方程", "加减乘除", "加法", "减法", "乘法", "除法", 
        "代数", "几何", "三角", "函数", "微积分", "概率", "统计", 
        "平方", "立方", "开方", "开根号", "+", "-", "*", "/", "=", "<", ">", "≠", "≤", "≥"
    ]
    
    # 检查消息中是否包含数学关键词
    for keyword in math_keywords:
        if keyword in message:
            return "MATH_TEACHER"
    
    # 默认为语文问题
    return "CHINESE_TEACHER"

async def route_message_to_agent(message, from_agent_id, to_agent_type, conv_id):
    """
    将消息从一个智能体路由到另一个智能体
    """
    # 找到目标类型的智能体
    target_agent = None
    for agent_id, agent_info in agents.items():
        if agent_info.get("agent_type") == to_agent_type:
            target_agent = agent_info
            break
    
    # 如果找不到目标类型的智能体，返回错误消息
    if not target_agent:
        return f"我需要请教{AGENT_TYPES[to_agent_type]}来回答这个问题，但目前系统中没有该类型的智能体。"
    
    # 构建转发消息
    forwarded_message = f"[转发自{agents[from_agent_id]['name']}] {message}"
    
    # 获取目标智能体的QA链
    vector_store_path = os.path.join(VECTOR_STORE_FOLDER, target_agent["id"])
    vector_store = None
    
    try:
        if os.path.exists(vector_store_path):
            vector_store = rag_core.load_vector_store(vector_store_path)
        else:
            # 创建一个空的向量存储
            from langchain_community.vectorstores import FAISS
            from langchain_community.embeddings import DashScopeEmbeddings
            from langchain.schema import Document
            
            api_key = os.getenv("DASHSCOPE_API_KEY", "sk-ea76fba3b52045579e38a398598ff512")
            embeddings = DashScopeEmbeddings(
                model="text-embedding-v1",
                dashscope_api_key=api_key
            )
            
            empty_docs = [Document(page_content="这是一个空的知识库", metadata={"source": "none"})]
            vector_store = FAISS.from_documents(empty_docs, embeddings)
    
        # 创建目标智能体的QA链
        role_prompt = target_agent.get("role", f"你是一个{AGENT_TYPES[to_agent_type]}。")
        qa_chain, streaming_handler = rag_core.setup_streaming_qa_chain(vector_store, role_prompt)
    
        # 获取回答
        response = qa_chain({"question": message})
        answer = response["answer"]
        
        # 构建返回消息
        return f"[{target_agent['name']}回答] {answer}"
    
    except Exception as e:
        print(f"路由消息到智能体时出错: {e}")
        return f"在尝试咨询{target_agent['name']}时发生错误。"

# --- 路由 ---

@app.route('/')
def index():
    """提供主页面"""
    return render_template('index.html')

@app.route('/api/agents', methods=['GET'])
def get_agents():
    """获取所有智能体"""
    return jsonify(list(agents.values()))

@app.route('/api/agents', methods=['POST'])
def create_agent():
    """创建新智能体"""
    # 获取表单数据
    agent_name = request.form.get('name', '').strip()
    agent_role = request.form.get('role', '').strip()
    agent_type = request.form.get('agent_type', 'DEFAULT').strip()
    
    if not agent_name:
        return jsonify({'error': '智能体名称不能为空'}), 400
    
    # 验证智能体类型是否有效
    if agent_type not in AGENT_TYPES:
        return jsonify({'error': '无效的智能体类型'}), 400
    
    # 创建新的智能体ID
    agent_id = str(uuid.uuid4())
    
    # 创建智能体信息
    agent_info = {
        'id': agent_id,
        'name': agent_name,
        'role': agent_role,
        'agent_type': agent_type,
        'type_name': AGENT_TYPES[agent_type],
        'created_at': time.time()
    }
    
    # 处理上传的文件
    files = request.files.getlist('files')
    if files and files[0].filename:  # 检查是否有文件上传
        # 为这个智能体创建上传目录
        agent_upload_dir = os.path.join(UPLOAD_FOLDER, agent_id)
        os.makedirs(agent_upload_dir, exist_ok=True)
        
        # 保存所有上传的文件
        for file in files:
            if file and allowed_file(file.filename):
                filename = secure_filename(file.filename)
                file_path = os.path.join(agent_upload_dir, filename)
                file.save(file_path)
        
        # 处理文档并创建向量存储
        try:
            # 加载文档
            documents = rag_core.load_documents(agent_upload_dir)
            
            # 分割文档
            chunks = rag_core.split_documents(documents)
            
            # 创建并保存向量存储
            vector_store_path = os.path.join(VECTOR_STORE_FOLDER, agent_id)
            rag_core.create_vector_store(chunks, vector_store_path)
            
            agent_info['has_knowledge_base'] = True
        except Exception as e:
            print(f"处理文档时出错: {e}")
            agent_info['has_knowledge_base'] = False
    else:
        agent_info['has_knowledge_base'] = False
    
    # 保存智能体信息
    agents[agent_id] = agent_info
    save_agent(agent_id, agent_info)
    
    # 创建一个新的对话
    conv_id = str(uuid.uuid4())
    conversations[conv_id] = {
        'qa_chain': None,  # 延迟加载
        'agent_id': agent_id,
        'messages': [],
        'title': f"与 {agent_name} 的对话",
        'created_at': time.time()
    }
    save_conversation(conv_id)
    
    return jsonify({
        'success': True,
        'message': '智能体创建成功',
        'agent': agent_info,
        'conversation_id': conv_id
    })

@app.route('/api/conversations', methods=['GET'])
def get_conversations():
    """获取所有对话"""
    result = []
    for conv_id, conv_data in conversations.items():
        agent_id = conv_data['agent_id']
        agent_name = agents.get(agent_id, {}).get('name', '未知智能体')
        
        result.append({
            'id': conv_id,
            'title': conv_data.get('title', f"与 {agent_name} 的对话"),
            'agent_id': agent_id,
            'agent_name': agent_name,
            'created_at': conv_data.get('created_at', time.time())
        })
    
    # 按创建时间排序，最新的在前面
    result.sort(key=lambda x: x['created_at'], reverse=True)
    return jsonify(result)

@app.route('/api/conversations', methods=['POST'])
def create_conversation():
    """创建新对话"""
    data = request.json
    agent_id = data.get('agent_id')
    
    if not agent_id or agent_id not in agents:
        return jsonify({'error': '无效的智能体ID'}), 400
    
    agent_info = agents[agent_id]
    
    # 创建新的对话ID
    conv_id = str(uuid.uuid4())
    
    # 创建对话
    conversations[conv_id] = {
        'qa_chain': None,  # 延迟加载
        'agent_id': agent_id,
        'messages': [],
        'title': f"与 {agent_info['name']} 的对话",
        'created_at': time.time()
    }
    save_conversation(conv_id)
    
    return jsonify({
        'id': conv_id,
        'title': f"与 {agent_info['name']} 的对话",
        'agent_id': agent_id
    })

@app.route('/api/conversations/<conv_id>', methods=['GET'])
def get_conversation(conv_id):
    """获取特定对话的详细信息"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404
    
    conv_data = conversations[conv_id]
    agent_id = conv_data['agent_id']
    agent_info = agents.get(agent_id, {'name': '未知智能体'})
    
    return jsonify({
        'id': conv_id,
        'title': conv_data.get('title', f"与 {agent_info['name']} 的对话"),
        'agent_id': agent_id,
        'agent_name': agent_info.get('name', '未知智能体'),
        'messages': conv_data['messages'],
        'created_at': conv_data.get('created_at', time.time())
    })

@app.route('/api/conversations/<conv_id>/messages', methods=['POST'])
def send_message(conv_id):
    """发送消息到对话"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404
    
    # 获取消息内容
    data = request.json
    if not data or 'message' not in data:
        return jsonify({'error': '消息不能为空'}), 400
    
    user_message = data['message']
    
    # 获取当前对话的智能体ID
    agent_id = conversations[conv_id]['agent_id']
    if agent_id not in agents:
        return jsonify({'error': '智能体不存在'}), 404
    
    # 获取QA链
    qa_chain = get_qa_chain(conv_id)
    if qa_chain is None:
        return jsonify({'error': '无法加载对话'}), 500
    
    # 添加用户消息到历史记录
    user_message_data = {
        'role': 'user',
        'content': user_message,
        'timestamp': time.time()
    }
    conversations[conv_id]['messages'].append(user_message_data)
    
    # 获取当前智能体信息
    current_agent = agents[agent_id]
    agent_type = current_agent.get('agent_type', 'DEFAULT')
    
    # 如果是语文老师智能体，检测意图
    intent_detected = False
    forwarded_response = None
    
    if agent_type == "CHINESE_TEACHER":
        detected_intent = detect_intent(user_message)
        
        # 如果检测到数学问题且当前智能体是语文老师
        if detected_intent == "MATH_TEACHER":
            intent_detected = True
            
            try:
                # 异步调用需要在异步函数中使用
                import asyncio
                forwarded_response = asyncio.run(route_message_to_agent(
                    user_message, agent_id, "MATH_TEACHER", conv_id
                ))
            except Exception as e:
                print(f"转发消息时出错: {e}")
                forwarded_response = f"我发现这是一个数学问题，但在尝试咨询数学老师时遇到了问题。"
    
    # 如果没有转发或者转发失败，使用当前智能体回答
    if not intent_detected or not forwarded_response:
        try:
            # 每隔10轮对话刷新一次上下文，防止长对话中丢失记忆
            message_count = len(conversations[conv_id]['messages'])
            if message_count > 0 and message_count % 20 == 0:  # 每20条消息刷新一次
                print(f"刷新对话 {conv_id} 的上下文，当前消息数: {message_count}")
                refresh_qa_chain_context(conv_id)
                qa_chain = get_qa_chain(conv_id)

            response = qa_chain({"question": user_message})
            ai_response = response["answer"]
        except Exception as e:
            print(f"获取回复时出错: {e}")
            return jsonify({'error': f'获取回复失败: {str(e)}'}), 500
    else:
        # 使用转发的回答
        ai_response = forwarded_response
    
    # 添加AI回复到历史记录
    ai_message = {
        'role': 'assistant',
        'content': ai_response,
        'timestamp': time.time(),
        'forwarded': intent_detected  # 标记是否为转发的回答
    }
    conversations[conv_id]['messages'].append(ai_message)
    
    # 保存对话
    save_conversation(conv_id)
    
    return jsonify({
        'success': True,
        'message': ai_message
    })

@app.route('/api/conversations/<conv_id>/title', methods=['PUT'])
def update_conversation_title(conv_id):
    """更新对话标题"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404
    
    data = request.json
    new_title = data.get('title', '').strip()
    
    if not new_title:
        return jsonify({'error': '标题不能为空'}), 400
    
    conversations[conv_id]['title'] = new_title
    save_conversation(conv_id)
    
    return jsonify({'success': True})

@app.route('/api/conversations/<conv_id>', methods=['DELETE'])
def delete_conversation(conv_id):
    """删除对话"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404

    # 从内存中删除
    del conversations[conv_id]

    # 从文件系统中删除
    conv_path = os.path.join(CONVERSATIONS_FOLDER, conv_id)
    if os.path.exists(conv_path):
        try:
            shutil.rmtree(conv_path)
        except Exception as e:
            print(f"删除对话文件夹时出错: {e}")
            return jsonify({'error': f'删除对话文件失败: {str(e)}'}), 500

    return jsonify({'success': True})

@app.route('/api/conversations/<conv_id>/refresh-context', methods=['POST'])
def refresh_conversation_context(conv_id):
    """手动刷新对话上下文，重新加载对话历史到AI记忆中"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404

    try:
        success = refresh_qa_chain_context(conv_id)
        if success:
            return jsonify({
                'success': True,
                'message': '对话上下文已刷新',
                'message_count': len(conversations[conv_id]['messages'])
            })
        else:
            return jsonify({'error': '刷新上下文失败'}), 500
    except Exception as e:
        print(f"刷新对话上下文时出错: {e}")
        return jsonify({'error': f'刷新上下文失败: {str(e)}'}), 500

@app.route('/api/conversations/<conv_id>/memory-status', methods=['GET'])
def get_conversation_memory_status(conv_id):
    """获取对话的记忆状态信息"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404

    conv_data = conversations[conv_id]
    qa_chain = conv_data.get('qa_chain')

    memory_info = {
        'conversation_id': conv_id,
        'total_messages': len(conv_data.get('messages', [])),
        'qa_chain_loaded': qa_chain is not None,
        'agent_id': conv_data.get('agent_id'),
        'agent_name': agents.get(conv_data.get('agent_id'), {}).get('name', '未知智能体')
    }

    if qa_chain and hasattr(qa_chain, 'memory'):
        try:
            # 获取内存中的对话历史
            chat_history = qa_chain.memory.chat_memory.messages
            memory_info.update({
                'memory_messages_count': len(chat_history),
                'memory_type': type(qa_chain.memory).__name__,
                'has_memory': True
            })
        except Exception as e:
            memory_info.update({
                'memory_error': str(e),
                'has_memory': False
            })
    else:
        memory_info['has_memory'] = False

    return jsonify(memory_info)

@app.route('/api/speech-to-text', methods=['POST'])
def process_speech():
    """处理语音输入，转换为文本"""
    if 'audio' not in request.files:
        return jsonify({'error': '没有找到音频文件'}), 400
    
    audio_file = request.files['audio']
    if audio_file.filename == '':
        return jsonify({'error': '没有选择音频文件'}), 400
    
    try:
        # 保存上传的音频文件
        temp_dir = os.path.join(UPLOAD_FOLDER, 'temp')
        os.makedirs(temp_dir, exist_ok=True)
        
        filename = secure_filename(f"audio_{int(time.time())}.webm")
        file_path = os.path.join(temp_dir, filename)
        audio_file.save(file_path)
        
        # 使用Whisper模型转换语音为文本
        text = speech_to_text.transcribe_audio(file_path)
        
        # 删除临时文件
        try:
            os.remove(file_path)
        except:
            pass
        
        return jsonify({'text': text})
    except Exception as e:
        print(f"语音转文本出错: {e}")
        return jsonify({'error': f'处理语音出错: {str(e)}'}), 500

@app.route('/api/text-to-speech', methods=['POST'])
def synthesize_speech():
    """将文本转换为语音"""
    data = request.json
    text = data.get('text', '').strip()
    voice = data.get('voice', 'zh-CN-XiaoxiaoNeural')
    
    if not text:
        return jsonify({'error': '文本不能为空'}), 400
    
    try:
        # 使用Edge TTS转换文本为语音
        success, result = text_to_speech.text_to_speech_bytes(text, voice)
        
        if not success:
            return jsonify({'error': f'生成语音失败: {result}'}), 500
        
        # 返回音频数据
        return send_file(
            io.BytesIO(result),
            mimetype='audio/mp3',
            as_attachment=True,
            download_name=f"speech_{int(time.time())}.mp3"
        )
    except Exception as e:
        error_message = f"文本转语音出错: {str(e)}"
        print(error_message)
        return jsonify({'error': error_message}), 500

@app.route('/api/conversations/<conv_id>/speak', methods=['POST'])
def speak_message(conv_id):
    """将最后一条AI消息转换为语音"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404
    
    conv_data = conversations[conv_id]
    messages = conv_data.get('messages', [])
    
    # 找到最后一条AI消息
    ai_messages = [msg for msg in messages if msg['role'] == 'assistant']
    if not ai_messages:
        return jsonify({'error': '没有找到AI消息'}), 404
    
    last_ai_message = ai_messages[-1]
    text = last_ai_message['content']
    
    try:
        # 使用Edge TTS转换文本为语音
        audio_data = text_to_speech.text_to_speech_bytes(text)
        
        if audio_data is None:
            return jsonify({'error': '生成语音失败'}), 500
        
        # 返回音频数据
        return send_file(
            io.BytesIO(audio_data),
            mimetype='audio/mp3',
            as_attachment=True,
            download_name=f"speech_{int(time.time())}.mp3"
        )
    except Exception as e:
        print(f"文本转语音出错: {e}")
        return jsonify({'error': f'生成语音出错: {str(e)}'}), 500

@app.route('/api/conversations/<conv_id>/stream', methods=['POST'])
def stream_conversation(conv_id):
    """流式处理对话，返回文本和音频流"""
    if conv_id not in conversations:
        return jsonify({'error': '对话不存在'}), 404
    
    data = request.json
    message = data.get('message', '').strip()
    
    if not message:
        return jsonify({'error': '消息不能为空'}), 400
    
    # 获取QA链
    qa_chain = get_qa_chain(conv_id)
    if qa_chain is None:
        return jsonify({'error': '无法加载对话'}), 500
    
    # 添加用户消息
    user_message = {
        'role': 'user',
        'content': message,
        'timestamp': time.time()
    }
    conversations[conv_id]['messages'].append(user_message)
    
    # 创建生成器函数获取流式响应
    def generate():
        try:
            # 创建文本累积器和语音合成队列
            accumulated_text = ""
            tts_queue = []
            last_tts_time = time.time()
            
            # 初始化Edge TTS
            tts = text_to_speech.TextToSpeech()
            
            # 获取流式AI回复
            for chunk in stream_llm_response(qa_chain, message):
                if chunk:
                    # 累积文本
                    accumulated_text += chunk
                    
                    # 当累积足够的文本或等待足够长时间时，生成语音
                    current_time = time.time()
                    if (len(accumulated_text) > 10 and "。" in accumulated_text) or \
                       (len(accumulated_text) > 20) or \
                       (current_time - last_tts_time > 2 and len(accumulated_text) > 5):
                        
                        # 生成语音
                        audio_data = asyncio.run(tts.text_to_speech_bytes_async(accumulated_text))
                        
                        # 发送文本和音频
                        response_data = {
                            'type': 'content',
                            'text': accumulated_text,
                            'audio': base64.b64encode(audio_data).decode('utf-8')
                        }
                        yield f"data: {json.dumps(response_data)}\n\n"
                        
                        # 重置累积文本和时间
                        accumulated_text = ""
                        last_tts_time = current_time
                    
                    # 如果没有累积足够文本，只发送文本更新
                    elif chunk:
                        response_data = {
                            'type': 'partial',
                            'text': chunk
                        }
                        yield f"data: {json.dumps(response_data)}\n\n"
            
            # 处理剩余的文本
            if accumulated_text:
                audio_data = asyncio.run(tts.text_to_speech_bytes_async(accumulated_text))
                response_data = {
                    'type': 'content',
                    'text': accumulated_text,
                    'audio': base64.b64encode(audio_data).decode('utf-8')
                }
                yield f"data: {json.dumps(response_data)}\n\n"
            
            # 添加完成标记
            full_response = accumulated_text  # 最终完整响应
            
            # 添加AI回复到对话历史
            ai_message = {
                'role': 'assistant',
                'content': full_response,
                'timestamp': time.time()
            }
            conversations[conv_id]['messages'].append(ai_message)
            
            # 保存对话
            save_conversation(conv_id)
            
            # 发送完成信号
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            
        except Exception as e:
            print(f"流式处理出错: {e}")
            # 如果出错，发送错误信息
            error_data = {
                'type': 'error',
                'error': str(e)
            }
            yield f"data: {json.dumps(error_data)}\n\n"
            
            # 如果出错，回滚用户消息
            conversations[conv_id]['messages'].pop()
    
    # 返回流式响应
    return Response(stream_with_context(generate()), 
                    mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache',
                             'X-Accel-Buffering': 'no'})

def stream_llm_response(qa_chain, question):
    """流式获取LLM响应"""
    try:
        # 实际发送问题并获取流式响应
        _, streaming_handler = qa_chain
        
        # 以非阻塞方式启动回答生成
        # 这里需要根据你的LLM接口调整
        import threading
        
        def generate_response():
            qa_chain.invoke({"question": question})
        
        # 在后台线程中启动生成
        thread = threading.Thread(target=generate_response)
        thread.start()
        
        # 从流式处理器中获取tokens
        for token in streaming_handler.get_tokens():
            if token:
                yield token
        
    except Exception as e:
        print(f"流式LLM响应出错: {e}")
        yield ""

# 添加WebSocket路由用于流式语音识别和回复
@socketio.on('connect')
def handle_connect():
    print('客户端已连接')

@socketio.on('disconnect')
def handle_disconnect():
    print('客户端已断开连接')

# 用于存储进行中的语音识别任务
active_transcriptions = {}

@socketio.on('start_voice_stream')
def start_voice_stream(data):
    """开始流式语音识别会话"""
    session_id = request.sid
    conv_id = data.get('conversation_id')
    
    if not conv_id or conv_id not in conversations:
        emit('error', {'message': '对话ID无效'})
        return
    
    active_transcriptions[session_id] = {
        'conversation_id': conv_id,
        'audio_chunks': []
    }
    
    emit('voice_stream_started', {'status': 'ready'})

@socketio.on('voice_data')
def handle_voice_data(data):
    """接收语音数据块并进行流式处理"""
    session_id = request.sid
    if session_id not in active_transcriptions:
        emit('error', {'message': '未找到有效的语音流会话'})
        return
    
    audio_chunk = data.get('audio_chunk')
    if not audio_chunk:
        return
    
    # 将base64编码的音频数据转换为二进制
    audio_binary = base64.b64decode(audio_chunk.split(',')[1] if ',' in audio_chunk else audio_chunk)
    
    active_transcriptions[session_id]['audio_chunks'].append(audio_binary)
    
    # 每收到一定量的音频数据，进行一次实时转写
    if len(active_transcriptions[session_id]['audio_chunks']) >= 3:  # 调整这个值以平衡响应速度和准确性
        threading.Thread(target=process_audio_chunk, args=(session_id,)).start()

def process_audio_chunk(session_id):
    """处理积累的音频数据块，进行实时转写"""
    if session_id not in active_transcriptions:
        return
        
    # 复制当前数据块然后清空，允许继续接收新数据
    audio_chunks = active_transcriptions[session_id]['audio_chunks'].copy()
    active_transcriptions[session_id]['audio_chunks'] = []
    
    # 合并音频数据
    from io import BytesIO
    combined_audio = BytesIO()
    for chunk in audio_chunks:
        combined_audio.write(chunk)
    combined_audio.seek(0)
    
    try:
        # 使用Whisper进行流式语音识别
        partial_text = speech_to_text.transcribe_audio(combined_audio.read())
        
        # 发送部分转写结果给客户端
        socketio.emit('partial_transcript', {'text': partial_text}, room=session_id)
    except Exception as e:
        print(f"流式语音识别出错: {e}")

@socketio.on('end_voice_stream')
def end_voice_stream(data):
    """结束语音流并处理完整的语音"""
    session_id = request.sid
    if session_id not in active_transcriptions:
        emit('error', {'message': '未找到有效的语音流会话'})
        return
    
    # 合并所有音频数据
    audio_chunks = active_transcriptions[session_id]['audio_chunks']
    conv_id = active_transcriptions[session_id]['conversation_id']
    
    if not audio_chunks:
        del active_transcriptions[session_id]
        emit('voice_stream_ended', {'status': 'empty'})
        return
    
    # 合并音频数据
    from io import BytesIO
    combined_audio = BytesIO()
    for chunk in audio_chunks:
        combined_audio.write(chunk)
    combined_audio.seek(0)
    
    try:
        # 使用Whisper进行完整语音识别
        final_text = speech_to_text.transcribe_audio(combined_audio.read())
        
        # 发送最终转写结果给客户端
        emit('final_transcript', {'text': final_text})
        
        # 如果有识别结果，处理用户消息并生成回复
        if final_text and conv_id in conversations:
            threading.Thread(target=process_message_and_stream_reply, 
                            args=(final_text, conv_id, session_id)).start()
    except Exception as e:
        print(f"处理完整语音出错: {e}")
        emit('error', {'message': f'处理语音出错: {str(e)}'})
    
    # 清理资源
    del active_transcriptions[session_id]

def process_message_and_stream_reply(message, conv_id, session_id):
    """处理用户消息并流式返回AI回复"""
    if not message or conv_id not in conversations:
        return

    # 检查是否需要刷新上下文
    message_count = len(conversations[conv_id]['messages'])
    if message_count > 0 and message_count % 20 == 0:
        print(f"流式处理中刷新对话 {conv_id} 的上下文，当前消息数: {message_count}")
        refresh_qa_chain_context(conv_id)

    # 获取QA链
    qa_chain = get_qa_chain(conv_id)
    if qa_chain is None:
        socketio.emit('error', {'message': '无法加载对话'}, room=session_id)
        return

    # 添加用户消息
    user_message = {
        'role': 'user',
        'content': message,
        'timestamp': time.time()
    }
    conversations[conv_id]['messages'].append(user_message)
    
    try:
        # 生成的回复文本
        full_response = ""
        
        # 获取模型的流式回复
        for chunk in qa_chain.stream({"question": message}):
            if "answer" in chunk:
                # 发送部分回复给客户端
                response_chunk = chunk["answer"]
                full_response += response_chunk
                socketio.emit('partial_response', {'text': response_chunk}, room=session_id)
                
                # 使用asyncio处理TTS的异步调用
                if len(response_chunk.strip()) > 0 and response_chunk.strip()[-1] in '.!?。！？':
                    # 当句子结束时，生成并发送语音片段
                    tts_thread = threading.Thread(target=stream_tts_for_chunk, 
                                              args=(response_chunk, session_id))
                    tts_thread.start()
        
        # 添加AI回复到对话历史
        ai_message = {
            'role': 'assistant',
            'content': full_response,
            'timestamp': time.time()
        }
        conversations[conv_id]['messages'].append(ai_message)
        
        # 保存对话
        save_conversation(conv_id)
        
        # 发送完成信号
        socketio.emit('response_complete', {'message_id': str(uuid.uuid4())}, room=session_id)
    
    except Exception as e:
        print(f"处理消息时出错: {e}")
        # 如果出错，回滚用户消息
        conversations[conv_id]['messages'].pop()
        socketio.emit('error', {'message': f'处理消息时出错: {str(e)}'}, room=session_id)

def stream_tts_for_chunk(text_chunk, session_id):
    """为文本块生成语音并流式发送"""
    try:
        # 生成语音
        audio_data = text_to_speech.text_to_speech_bytes(text_chunk)
        
        if audio_data:
            # 将二进制音频数据转换为base64编码
            audio_b64 = base64.b64encode(audio_data).decode('utf-8')
            
            # 发送语音数据给客户端
            socketio.emit('audio_chunk', {
                'audio_data': f'data:audio/mp3;base64,{audio_b64}'
            }, room=session_id)
    except Exception as e:
        print(f"生成语音出错: {e}")

@app.route('/api/agents/<agent_id>', methods=['GET'])
def get_agent(agent_id):
    """获取特定智能体的详细信息"""
    if agent_id not in agents:
        return jsonify({'error': '智能体不存在'}), 404
    
    return jsonify(agents[agent_id])

@app.route('/api/agents/<agent_id>', methods=['DELETE'])
def delete_agent(agent_id):
    """删除智能体及其相关资源"""
    if agent_id not in agents:
        return jsonify({'error': '智能体不存在'}), 404
    
    try:
        # 1. 删除与该智能体相关的对话
        related_conv_ids = []
        for conv_id, conv_data in list(conversations.items()):
            if conv_data['agent_id'] == agent_id:
                related_conv_ids.append(conv_id)
        
        # 删除关联的对话
        for conv_id in related_conv_ids:
            # 从内存中删除
            if conv_id in conversations:
                del conversations[conv_id]
            
            # 从文件系统中删除
            conv_path = os.path.join(CONVERSATIONS_FOLDER, conv_id)
            if os.path.exists(conv_path):
                try:
                    shutil.rmtree(conv_path)
                except Exception as e:
                    print(f"删除对话文件夹时出错: {e}")
        
        # 2. 删除智能体的上传文件
        agent_upload_dir = os.path.join(UPLOAD_FOLDER, agent_id)
        if os.path.exists(agent_upload_dir):
            try:
                shutil.rmtree(agent_upload_dir)
            except Exception as e:
                print(f"删除智能体上传文件夹时出错: {e}")
        
        # 3. 删除智能体的向量存储
        vector_store_path = os.path.join(VECTOR_STORE_FOLDER, agent_id)
        if os.path.exists(vector_store_path):
            try:
                shutil.rmtree(vector_store_path)
            except Exception as e:
                print(f"删除智能体向量存储时出错: {e}")
        
        # 4. 删除智能体文件夹
        agent_path = os.path.join(AGENTS_FOLDER, agent_id)
        if os.path.exists(agent_path):
            try:
                shutil.rmtree(agent_path)
            except Exception as e:
                print(f"删除智能体文件夹时出错: {e}")
        
        # 5. 从内存中删除
        agent_info = agents[agent_id]  # 保存用于返回
        del agents[agent_id]
        
        return jsonify({
            'success': True,
            'message': '智能体删除成功',
            'agent': agent_info,
            'deleted_conversations': len(related_conv_ids)
        })
        
    except Exception as e:
        print(f"删除智能体时出错: {e}")
        return jsonify({'error': f'删除智能体失败: {str(e)}'}), 500

# --- 初始化 ---

# 加载已保存的智能体和对话
load_agents()
load_conversations()

if __name__ == '__main__':
    socketio.run(app, debug=True, port=5001, allow_unsafe_werkzeug=True) 