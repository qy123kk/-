"""
语音转文本模块 - 使用OpenAI的Whisper模型
"""

import os
import tempfile
import numpy as np
import torch
import whisper
from datetime import datetime

class SpeechToText:
    """使用Whisper模型将语音转换为文本"""
    
    def __init__(self, model_name="base", device=None):
        """
        初始化Whisper模型
        
        Args:
            model_name: Whisper模型名称，可选值：tiny, base, small, medium, large
            device: 计算设备，可选值：cpu, cuda。如果为None，则自动选择
        """
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        
        self.model_name = model_name
        self.device = device
        print(f"正在加载Whisper模型 ({model_name})...")
        self.model = whisper.load_model(model_name, device=device)
        print(f"Whisper模型加载完成，使用设备: {device}")
    
    def transcribe_audio(self, audio_file, language="zh"):
        """
        将音频文件转换为文本
        
        Args:
            audio_file: 音频文件路径或二进制数据
            language: 音频语言，默认为中文
            
        Returns:
            转换后的文本
        """
        try:
            # 如果是二进制数据，先保存为临时文件
            if isinstance(audio_file, bytes):
                with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as temp_file:
                    temp_filename = temp_file.name
                    temp_file.write(audio_file)
                
                audio_file = temp_filename
            
            # 使用Whisper模型转录音频
            result = self.model.transcribe(
                audio_file,
                language=language,
                task="transcribe"
            )
            
            # 如果使用了临时文件，删除它
            if 'temp_filename' in locals():
                try:
                    os.remove(temp_filename)
                except:
                    pass
                
            return result["text"].strip()
            
        except Exception as e:
            print(f"音频转文本出错: {e}")
            return ""

# 单例模式，避免重复加载模型
_instance = None

def get_transcriber(model_name="base", device=None):
    """获取SpeechToText实例（单例模式）"""
    global _instance
    if _instance is None:
        _instance = SpeechToText(model_name, device)
    return _instance

def transcribe_audio(audio_data, language="zh"):
    """
    将音频数据转换为文本的便捷函数
    
    Args:
        audio_data: 音频二进制数据或文件路径
        language: 音频语言，默认为中文
        
    Returns:
        转换后的文本
    """
    transcriber = get_transcriber()
    return transcriber.transcribe_audio(audio_data, language) 