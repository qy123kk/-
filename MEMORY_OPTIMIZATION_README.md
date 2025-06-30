# 多轮对话功能和提示词记忆功能优化

## 优化概述

本次优化主要针对多轮对话功能和提示词记忆功能进行了全面改进，确保AI能够在长时间对话中保持上下文记忆和角色一致性。

## 主要优化内容

### 1. 对话记忆管理优化

#### 1.1 自适应记忆策略
- **短对话**（<20条消息）：使用 `ConversationBufferMemory` 完整保存所有历史
- **长对话**（≥20条消息）：使用 `ConversationSummaryBufferMemory` 自动总结压缩

#### 1.2 上下文恢复机制
- 新增 `restore_conversation_history()` 函数，确保QA链创建时能正确恢复历史对话
- 优化 `get_qa_chain()` 函数，支持传入对话历史进行上下文重建

#### 1.3 定期上下文刷新
- 每20条消息自动刷新一次上下文，防止长对话中记忆丢失
- 支持手动刷新上下文功能

### 2. 提示词记忆增强

#### 2.1 动态提示词构建
- 新增 `build_context_prompt()` 函数，动态构建包含历史上下文的提示词
- 保留最近6条消息作为上下文参考
- 智能提取对话摘要，压缩长对话信息

#### 2.2 角色一致性保持
- 在每次QA链创建时重新设置系统提示词
- 结合历史对话内容，确保AI角色设定的连贯性

### 3. 内存优化策略

#### 3.1 对话历史优化
- 新增 `optimize_conversation_memory()` 函数
- 保留开头4条重要消息（包含角色设定）
- 保留最近的消息，总长度控制在50条以内

#### 3.2 智能摘要提取
- 新增 `extract_conversation_summary()` 函数
- 自动提取对话中的关键词和主题
- 为长对话生成简洁的上下文摘要

### 4. 用户界面增强

#### 4.1 新增控制按钮
- **刷新记忆按钮**：手动刷新对话上下文
- **记忆状态按钮**：查看当前对话的记忆状态

#### 4.2 状态可视化
- 显示对话总消息数
- 显示QA链加载状态
- 显示记忆类型和消息数量
- 实时反馈上下文刷新结果

### 5. API接口扩展

#### 5.1 新增API端点
```
POST /api/conversations/{conv_id}/refresh-context
GET /api/conversations/{conv_id}/memory-status
```

#### 5.2 功能说明
- `refresh-context`：手动刷新对话上下文
- `memory-status`：获取详细的记忆状态信息

## 技术实现细节

### 核心文件修改

1. **rag_core.py**
   - 新增自适应记忆管理
   - 优化QA链创建流程
   - 增强上下文处理能力

2. **app.py**
   - 优化对话处理逻辑
   - 新增API端点
   - 改进流式处理

3. **templates/index.html**
   - 新增控制按钮
   - 优化界面布局

4. **static/script.js**
   - 新增前端交互功能
   - 实现状态显示
   - 优化用户体验

5. **static/style.css**
   - 新增样式定义
   - 美化界面元素

### 关键算法

#### 记忆优化算法
```python
def optimize_conversation_memory(conversation_history, max_history_length=50):
    if len(conversation_history) <= max_history_length:
        return conversation_history
    
    # 保留开头4条消息（重要上下文）
    start_messages = conversation_history[:4]
    
    # 保留最近的消息
    recent_messages = conversation_history[-(max_history_length-4):]
    
    return start_messages + recent_messages
```

#### 上下文构建算法
```python
def build_context_prompt(base_prompt, conversation_history=None):
    context_prompt = base_prompt
    
    if conversation_history and len(conversation_history) > 0:
        # 获取最近6条消息作为上下文
        recent_history = conversation_history[-6:]
        
        context_prompt += "\n\n以下是我们之前的对话历史，请参考这些内容来保持对话的连贯性：\n"
        
        for message in recent_history:
            if message['role'] == 'user':
                context_prompt += f"用户: {message['content']}\n"
            elif message['role'] == 'assistant':
                context_prompt += f"助手: {message['content']}\n"
        
        context_prompt += "\n请基于以上对话历史和你的角色设定，继续与用户进行自然的对话。"
    
    return context_prompt
```

## 使用说明

### 1. 启动应用
```bash
python app.py
```

### 2. 测试记忆功能
```bash
python test_memory_optimization.py
```

### 3. 使用新功能
1. 在对话界面中，点击"刷新记忆"按钮手动刷新上下文
2. 点击"记忆状态"按钮查看当前记忆状态
3. 系统会在每20条消息后自动刷新上下文

## 性能优化

### 内存使用
- 长对话自动压缩，避免内存无限增长
- 智能摘要减少存储空间占用
- 延迟加载QA链，提高启动速度

### 响应速度
- 优化上下文构建算法
- 减少不必要的模型调用
- 改进缓存策略

## 测试验证

### 自动化测试
运行 `test_memory_optimization.py` 进行全面测试：
- 创建测试智能体
- 进行8轮连续对话
- 验证记忆保持效果
- 测试上下文刷新功能

### 手动测试建议
1. 创建一个智能体，进行长时间对话（>30轮）
2. 在对话中提及个人信息，后续验证AI是否记住
3. 使用"记忆状态"功能查看内存使用情况
4. 测试"刷新记忆"功能的效果

## 注意事项

1. **模型依赖**：确保Ollama服务正常运行，qwen2.5:3b模型已下载
2. **API密钥**：确保DashScope API密钥配置正确
3. **内存监控**：长时间使用时注意监控系统内存使用情况
4. **备份数据**：重要对话建议定期备份

## 后续优化方向

1. **智能摘要**：集成更先进的摘要算法
2. **个性化记忆**：根据用户习惯调整记忆策略
3. **多模态记忆**：支持图片、文件等多媒体内容记忆
4. **分布式存储**：支持大规模对话的分布式存储
5. **实时同步**：支持多设备间的对话同步
