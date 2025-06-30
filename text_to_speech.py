"""
文本转语音模块 - 使用Edge TTS
"""

import os
import asyncio
import tempfile
import edge_tts
import time
import glob
import threading
from datetime import datetime, timedelta

# 定义临时目录
TTS_TEMP_DIR = os.path.join(tempfile.gettempdir(), "tts_temp")
# 确保临时目录存在
os.makedirs(TTS_TEMP_DIR, exist_ok=True)

class TextToSpeech:
    """使用Edge TTS将文本转换为语音"""
    
    def __init__(self, voice="zh-CN-XiaoxiaoNeural"):
        """
        初始化Edge TTS
        
        Args:
            voice: 语音名称，默认为中文女声
                常用选项:
                - zh-CN-XiaoxiaoNeural (女声)
                - zh-CN-YunxiNeural (男声)
                - zh-CN-YunyangNeural (男声)
                - en-US-AriaNeural (英语女声)
        """
        self.voice = voice
    
    async def text_to_speech_async(self, text, output_file=None, rate="+0%", volume="+0%"):
        """
        将文本转换为语音
        
        Args:
            text: 要转换的文本
            output_file: 输出文件路径，如果为None则生成临时文件
            rate: 语速调整，如"+10%"表示加快10%
            volume: 音量调整，如"+10%"表示增加10%
            
        Returns:
            输出文件路径
        """
        try:
            # 如果没有指定输出文件，创建临时文件
            if output_file is None:
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                output_file = os.path.join(TTS_TEMP_DIR, f"tts_{timestamp}.mp3")
            
            # 设置语音参数
            communicate = edge_tts.Communicate(text, self.voice)
            
            # 调整语速和音量
            if rate != "+0%":
                communicate.rate = rate
            if volume != "+0%":
                communicate.volume = volume
            
            # 生成语音
            await communicate.save(output_file)
            
            return output_file
            
        except Exception as e:
            print(f"文本转语音出错: {e}")
            return None

    def text_to_speech(self, text, output_file=None, rate="+0%", volume="+0%"):
        """
        将文本转换为语音（同步版本）
        
        Args:
            text: 要转换的文本
            output_file: 输出文件路径，如果为None则生成临时文件
            rate: 语速调整，如"+10%"表示加快10%
            volume: 音量调整，如"+10%"表示增加10%
            
        Returns:
            输出文件路径
        """
        return asyncio.run(self.text_to_speech_async(text, output_file, rate, volume))

    async def text_to_speech_bytes_async(self, text, rate="+0%", volume="+0%"):
        """
        将文本转换为语音并返回二进制数据
        
        Args:
            text: 要转换的文本
            rate: 语速调整，如"+10%"表示加快10%
            volume: 音量调整，如"+10%"表示增加10%
            
        Returns:
            成功时: (True, 语音的二进制数据)
            失败时: (False, 错误信息)
        """
        temp_filename = None
        try:
            if not text or text.strip() == "":
                return False, "文本内容为空"
                
            # 创建临时文件
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            temp_filename = os.path.join(TTS_TEMP_DIR, f"tts_temp_{timestamp}.mp3")
            
            # 生成语音文件
            await self.text_to_speech_async(text, temp_filename, rate, volume)
            
            # 读取文件内容
            with open(temp_filename, "rb") as f:
                audio_data = f.read()
            
            return True, audio_data
            
        except Exception as e:
            error_msg = f"文本转语音出错: {str(e)}"
            print(error_msg)
            return False, error_msg
        finally:
            # 确保始终删除临时文件
            if temp_filename and os.path.exists(temp_filename):
                try:
                    os.remove(temp_filename)
                except Exception as e:
                    print(f"删除临时文件出错: {e}")
    
    def text_to_speech_bytes(self, text, rate="+0%", volume="+0%"):
        """
        将文本转换为语音并返回二进制数据（同步版本）
        
        Args:
            text: 要转换的文本
            rate: 语速调整，如"+10%"表示加快10%
            volume: 音量调整，如"+10%"表示增加10%
            
        Returns:
            成功时: (True, 语音的二进制数据)
            失败时: (False, 错误信息)
        """
        return asyncio.run(self.text_to_speech_bytes_async(text, rate, volume))

# 创建默认实例
default_tts = TextToSpeech()

def text_to_speech(text, output_file=None, voice="zh-CN-XiaoxiaoNeural", rate="+0%", volume="+0%"):
    """
    将文本转换为语音的便捷函数
    
    Args:
        text: 要转换的文本
        output_file: 输出文件路径，如果为None则生成临时文件
        voice: 语音名称
        rate: 语速调整
        volume: 音量调整
        
    Returns:
        输出文件路径
    """
    tts = TextToSpeech(voice)
    return tts.text_to_speech(text, output_file, rate, volume)

def text_to_speech_bytes(text, voice="zh-CN-XiaoxiaoNeural", rate="+0%", volume="+0%"):
    """
    将文本转换为语音并返回二进制数据的便捷函数
    
    Args:
        text: 要转换的文本
        voice: 语音名称
        rate: 语速调整
        volume: 音量调整
        
    Returns:
        成功时: (True, 语音的二进制数据)
        失败时: (False, 错误信息)
    """
    tts = TextToSpeech(voice)
    return tts.text_to_speech_bytes(text, rate, volume)

def cleanup_temp_files(max_age_hours=24):
    """
    清理过期的临时文件
    
    Args:
        max_age_hours: 文件保留的最大小时数
    """
    try:
        print(f"正在清理临时文件，保留最近{max_age_hours}小时内的文件...")
        now = datetime.now()
        cutoff_time = now - timedelta(hours=max_age_hours)
        
        # 获取所有tts开头的临时文件
        file_pattern = os.path.join(TTS_TEMP_DIR, "tts_*.mp3")
        for file_path in glob.glob(file_pattern):
            try:
                file_stat = os.stat(file_path)
                file_mtime = datetime.fromtimestamp(file_stat.st_mtime)
                
                # 如果文件超过最大保留时间，删除它
                if file_mtime < cutoff_time:
                    os.remove(file_path)
                    print(f"已删除过期临时文件: {file_path}")
            except Exception as e:
                print(f"处理临时文件出错: {file_path}, 错误: {e}")
    except Exception as e:
        print(f"清理临时文件时出错: {e}")

def start_cleanup_scheduler():
    """启动定期清理临时文件的调度器"""
    def cleanup_task():
        while True:
            cleanup_temp_files()
            # 每小时运行一次清理
            time.sleep(3600)
    
    # 在后台线程中启动清理任务
    cleanup_thread = threading.Thread(target=cleanup_task, daemon=True)
    cleanup_thread.start()
    print("已启动临时文件清理调度器")

# 应用启动时执行一次清理
cleanup_temp_files()
# 启动定期清理
start_cleanup_scheduler() 