"""模式 A · 离线 Gradio Demo。

本目录下是「单机批改」流程的全部代码：
- ``app.py``         —— Gradio UI 入口（``uv run python -m demo.app``）
- ``filenames.py``   —— ``data/input/学号_姓名/页码.jpg`` 文件夹扫描
- ``storage.py``     —— 每位学生一份 record JSON 落盘 / 读盘

业务核心（OCR / 批改 / provider）在 ``core/`` 里，与中台 (``backend/``) 共享。
"""
