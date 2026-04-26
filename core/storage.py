"""任务与结果持久化。每个学生一条 record，落到 data/records/<key>.json。"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

from .config import DATA_DIR

RECORDS_DIR = DATA_DIR / "records"


@dataclass
class StudentRecord:
    key: str
    student_id: str
    student_name: str
    folder_path: str
    folder_name: str
    image_paths: list[str] = field(default_factory=list)
    transcription: str = ""
    transcription_edited: bool = False
    grading: str = ""
    grading_edited: bool = False
    score: int | None = None
    ocr_status: str = "pending"
    grading_status: str = "pending"
    error: str = ""
    updated_at: str = ""

    @property
    def page_count(self) -> int:
        return len(self.image_paths)

    def existing_image_paths(self) -> list[str]:
        return [p for p in self.image_paths if Path(p).exists()]

    def save(self) -> None:
        RECORDS_DIR.mkdir(parents=True, exist_ok=True)
        self.updated_at = datetime.now().isoformat(timespec="seconds")
        path = RECORDS_DIR / f"{self.key}.json"
        path.write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    @classmethod
    def load(cls, key: str) -> "StudentRecord | None":
        path = RECORDS_DIR / f"{key}.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        data.pop("image_path", None)
        data.pop("filename", None)
        return cls(**data)

    @classmethod
    def load_all(cls) -> list["StudentRecord"]:
        if not RECORDS_DIR.exists():
            return []
        out: list[StudentRecord] = []
        for p in sorted(RECORDS_DIR.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                data.pop("image_path", None)
                data.pop("filename", None)
                out.append(cls(**data))
            except Exception:
                continue
        return out


def make_key(student_id: str, student_name: str) -> str:
    raw = f"{student_id}_{student_name}"
    return re.sub(r"[^\w\u4e00-\u9fffぁ-んァ-ヶ一-龯]", "_", raw)


_NUM = r"(\d{1,3}(?:\.\d+)?)"
_LABEL = r"(?:总分|最终得分|总得分)"

SCORE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(rf"{_LABEL}[^\n]*?{_NUM}\s*/\s*(?:30|100)"),
    re.compile(rf"{_LABEL}\s*[:：]\s*\*{{0,2}}{_NUM}\*{{0,2}}"),
    re.compile(rf"{_LABEL}[^0-9\n]{{0,10}}{_NUM}"),
]

ROW_RE = re.compile(rf"^[^\n]*{_LABEL}[^\n]*$", re.MULTILINE)
ROW_NUM_RE = re.compile(r"\d{1,3}(?:\.\d+)?")


def extract_score(grading_md: str) -> int | None:
    """从批改 Markdown 里抓总分。支持「总分/最终得分」+「/30 或 /100」+ 小数。"""
    if not grading_md:
        return None
    for pat in SCORE_PATTERNS[:2]:
        m = pat.search(grading_md)
        if m:
            v = _to_int(m.group(1))
            if v is not None:
                return v
    for row in ROW_RE.findall(grading_md):
        nums = [float(x) for x in ROW_NUM_RE.findall(row)]
        if not nums:
            continue
        candidates = [n for n in nums if n not in (30.0, 100.0)] or nums
        v = _to_int(str(candidates[-1]))
        if v is not None:
            return v
    m = SCORE_PATTERNS[2].search(grading_md)
    if m:
        return _to_int(m.group(1))
    return None


def _to_int(s: str) -> int | None:
    try:
        v = float(s)
    except ValueError:
        return None
    return int(round(v)) if 0 <= v <= 100 else None
