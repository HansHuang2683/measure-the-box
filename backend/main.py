"""
FBA 装箱优化工具 — 后端 API
FastAPI + SQLite + JWT 认证
启动: python main.py  或  uvicorn main:app --reload
"""

import os
from datetime import datetime, timedelta, timezone
import json
import time
from collections import defaultdict
from typing import Optional, List

from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey
from sqlalchemy.orm import sessionmaker, Session, declarative_base
import bcrypt
from jose import jwt, JWTError
from pydantic import BaseModel

# ── 配置 ──────────────────────────────────────────────

DATABASE_URL = "sqlite:///./fba_packing.db"
SECRET_KEY = os.environ.get("SECRET_KEY")
if not SECRET_KEY:
    raise RuntimeError("环境变量 SECRET_KEY 未设置！请设置一个随机密钥用于 JWT 签名。")
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24
CORS_ORIGINS = os.environ.get("CORS_ORIGINS", "").split(",") if os.environ.get("CORS_ORIGINS") else [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

# ── 初始化 ────────────────────────────────────────────

app = FastAPI(title="FBA Packing Optimizer API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()
security = HTTPBearer()

# ── 数据模型 ──────────────────────────────────────────

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    created_at = Column(String, default=lambda: datetime.now(timezone.utc).isoformat())


class SavedData(Base):
    __tablename__ = "saved_data"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String, nullable=False)
    skus_data = Column(Text, nullable=False)
    box_types_data = Column(Text, nullable=False)
    mixed_groups_data = Column(Text, nullable=False)
    result_data = Column(Text, nullable=True)
    created_at = Column(String, default=lambda: datetime.now(timezone.utc).isoformat())

# ── Pydantic 请求/响应 schema ─────────────────────────

class RegisterRequest(BaseModel):
    username: str
    password: str


class LoginRequest(BaseModel):
    username: str
    password: str


class SaveDataRequest(BaseModel):
    name: str
    skus_data: List[dict]
    box_types_data: List[dict]
    mixed_groups_data: List[dict]
    result_data: Optional[dict] = None


class SavedDataSummary(BaseModel):
    id: int
    name: str
    created_at: str


class SavedDataDetail(BaseModel):
    id: int
    name: str
    skus_data: List[dict]
    box_types_data: List[dict]
    mixed_groups_data: List[dict]
    result_data: Optional[dict]
    created_at: str

# ── 速率限制 ──────────────────────────────────────────

_rate_limit_store = defaultdict(list)  # ip -> [timestamp, ...]

def check_rate_limit(request: Request, max_requests: int = 10, window_seconds: int = 60):
    """每个 IP 在窗口内最多 max_requests 次，超限则抛出 429"""
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    window_start = now - window_seconds
    _rate_limit_store[client_ip] = [t for t in _rate_limit_store[client_ip] if t > window_start]
    if len(_rate_limit_store[client_ip]) >= max_requests:
        raise HTTPException(status_code=429, detail="请求过于频繁，请稍后再试")
    _rate_limit_store[client_ip].append(now)

# ── 数据库依赖 ────────────────────────────────────────

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# ── 认证工具 ──────────────────────────────────────────

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def create_token(user_id: int, username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRE_HOURS)
    payload = {"sub": str(user_id), "username": username, "exp": expire}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_db),
) -> User:
    try:
        payload = jwt.decode(credentials.credentials, SECRET_KEY, algorithms=[ALGORITHM])
        user_id = int(payload.get("sub"))
    except (JWTError, ValueError, TypeError):
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user

# ── 认证接口 ──────────────────────────────────────────

@app.post("/api/auth/register")
def register(request: Request, body: RegisterRequest, db: Session = Depends(get_db)):
    check_rate_limit(request, max_requests=5, window_seconds=60)
    if not body.username or len(body.username) < 3:
        raise HTTPException(status_code=400, detail="用户名至少 3 个字符")
    if not body.password or len(body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 个字符")
    if len(body.password) > 72:
        raise HTTPException(status_code=400, detail="密码不能超过 72 个字符")
    if db.query(User).filter(User.username == body.username).first():
        raise HTTPException(status_code=400, detail="用户名已存在")

    user = User(username=body.username, password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_token(user.id, user.username)
    return {"id": user.id, "username": user.username, "token": token}


@app.post("/api/auth/login")
def login(request: Request, body: LoginRequest, db: Session = Depends(get_db)):
    check_rate_limit(request, max_requests=10, window_seconds=60)
    user = db.query(User).filter(User.username == body.username).first()
    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = create_token(user.id, user.username)
    return {"id": user.id, "username": user.username, "token": token}

# ── 装箱数据接口 ──────────────────────────────────────

@app.post("/api/box-data")
def save_box_data(
    body: SaveDataRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if not body.name or not body.name.strip():
        raise HTTPException(status_code=400, detail="名称不能为空")

    entry = SavedData(
        user_id=current_user.id,
        name=body.name.strip(),
        skus_data=json.dumps(body.skus_data, ensure_ascii=False),
        box_types_data=json.dumps(body.box_types_data, ensure_ascii=False),
        mixed_groups_data=json.dumps(body.mixed_groups_data, ensure_ascii=False),
        result_data=json.dumps(body.result_data, ensure_ascii=False) if body.result_data else "{}",
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return {"id": entry.id, "name": entry.name, "created_at": entry.created_at}


@app.get("/api/box-data")
def list_box_data(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    entries = (
        db.query(SavedData)
        .filter(SavedData.user_id == current_user.id)
        .order_by(SavedData.created_at.desc())
        .all()
    )
    return [
        {"id": e.id, "name": e.name, "created_at": e.created_at}
        for e in entries
    ]


@app.get("/api/box-data/{entry_id}")
def get_box_data(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    entry = (
        db.query(SavedData)
        .filter(SavedData.id == entry_id, SavedData.user_id == current_user.id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="记录不存在或无权访问")

    return {
        "id": entry.id,
        "name": entry.name,
        "skus_data": json.loads(entry.skus_data),
        "box_types_data": json.loads(entry.box_types_data),
        "mixed_groups_data": json.loads(entry.mixed_groups_data),
        "result_data": json.loads(entry.result_data) if entry.result_data else None,
        "created_at": entry.created_at,
    }


@app.delete("/api/box-data/{entry_id}")
def delete_box_data(
    entry_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    entry = (
        db.query(SavedData)
        .filter(SavedData.id == entry_id, SavedData.user_id == current_user.id)
        .first()
    )
    if not entry:
        raise HTTPException(status_code=404, detail="记录不存在或无权访问")
    db.delete(entry)
    db.commit()
    return {"success": True}

# ── 启动事件 ──────────────────────────────────────────

from contextlib import asynccontextmanager

@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield

app.router.lifespan_context = lifespan

# ── 静态文件托管 ──────────────────────────────────────

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app.mount("/", StaticFiles(directory=PROJECT_ROOT, html=True), name="frontend")

# ── 入口 ──────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
