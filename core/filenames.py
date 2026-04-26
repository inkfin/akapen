"""学生文件夹扫描。

约定的输入结构：
    data/input/
    ├── 2024001_王伟/        ← 文件夹名 = 学号_姓名
    │   ├── 1.jpg            ← 内部文件按页码命名
    │   ├── 2.jpg
    │   └── 3.jpg
    └── 2024002_李娜/
        └── 1.jpg

文件夹命名规则：第一个下划线之前是学号，之后全部是姓名。
图片排序：优先按文件名里的数字（页码），其次字典序。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

SUPPORTED_EXTS = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass
class ScannedStudent:
    folder: Path
    folder_name: str
    student_id: str
    student_name: str
    image_paths: list[Path] = field(default_factory=list)
    valid: bool = False
    reason: str = ""


def scan_folder(input_dir: str | Path) -> list[ScannedStudent]:
    """扫描 input_dir 下所有学生子文件夹。"""
    base = Path(input_dir).expanduser().resolve()
    if not base.exists() or not base.is_dir():
        raise FileNotFoundError(f"文件夹不存在：{base}")

    students: list[ScannedStudent] = []
    for entry in sorted(base.iterdir()):
        if not entry.is_dir():
            continue
        if entry.name.startswith("."):
            continue
        students.append(_parse_student_folder(entry))

    _check_duplicates(students)
    return students


def _parse_student_folder(folder: Path) -> ScannedStudent:
    name = folder.name
    student = ScannedStudent(folder=folder, folder_name=name,
                             student_id="", student_name="")

    if "_" not in name:
        student.reason = "文件夹名应为「学号_姓名」（缺少下划线）"
        return student

    sid, sname = name.split("_", 1)
    sid, sname = sid.strip(), sname.strip()
    if not sid or not sname:
        student.reason = "学号或姓名为空"
        return student

    images = sorted(
        (p for p in folder.iterdir()
         if p.is_file() and p.suffix.lower() in SUPPORTED_EXTS),
        key=_page_sort_key,
    )
    if not images:
        student.student_id = sid
        student.student_name = sname
        student.reason = "文件夹内没有图片"
        return student

    student.student_id = sid
    student.student_name = sname
    student.image_paths = images
    student.valid = True
    return student


_NUM_RE = re.compile(r"\d+")


def _page_sort_key(p: Path) -> tuple[int, int | str]:
    """按文件名里的数字排序（无数字时按字典序）。"""
    m = _NUM_RE.search(p.stem)
    if m:
        return (0, int(m.group()))
    return (1, p.stem)


def _check_duplicates(students: Iterable[ScannedStudent]) -> None:
    seen: dict[str, ScannedStudent] = {}
    for s in students:
        if not s.valid:
            continue
        key = f"{s.student_id}_{s.student_name}"
        if key in seen:
            s.valid = False
            s.reason = f"与 {seen[key].folder_name}/ 重复"
        else:
            seen[key] = s
