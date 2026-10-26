from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from database import engine, Base
from routers import auth_router, decks_router, cards_router, study_router, shared_router, apkg_router, notes_router, options_router

# Create all tables
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="AnkiClone API",
    description="Spaced Repetition Flashcard Platform API",
    version="1.0.0",
)

import os

MEDIA_DIR = os.getenv("MEDIA_DIR", os.path.join(os.path.dirname(__file__), "media"))
# Create media/ directory if it doesn't exist
os.makedirs(MEDIA_DIR, exist_ok=True)


# CORS
allowed_origins = os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://127.0.0.1:5173"
).split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import logging
from fastapi import HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; "
        "media-src 'self' data: blob: https:; "
        "connect-src 'self' http: https: ws: wss:;"
    )
    return response

@app.exception_handler(Exception)
@app.exception_handler(RequestValidationError)
async def generic_exception_handler(request: Request, exc: Exception):
    if isinstance(exc, (HTTPException, StarletteHTTPException)):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.detail},
            headers=getattr(exc, "headers", None),
        )
    if isinstance(exc, RequestValidationError):
        clean_errors = [{"loc": err.get("loc"), "msg": err.get("msg")} for err in exc.errors()]
        return JSONResponse(
            status_code=422,
            content={"detail": clean_errors},
        )
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )

# Include routers
app.include_router(auth_router.router)
app.include_router(decks_router.router)
app.include_router(cards_router.router)
app.include_router(study_router.router)
app.include_router(shared_router.router)
app.include_router(apkg_router.router)
app.include_router(notes_router.router)
app.include_router(options_router.router)

# Mount static files
app.mount("/api/media", StaticFiles(directory=MEDIA_DIR), name="media")


@app.get("/")
def root():
    return {"message": "AnkiClone API is running", "docs": "/docs"}

from routers import filtered_router
app.include_router(filtered_router.router)

from routers import stats_router
app.include_router(stats_router.router)

from routers import note_types_router
app.include_router(note_types_router.router)

from routers import media_router
app.include_router(media_router.router)

from routers import optimizer_router
app.include_router(optimizer_router.router)

from routers import backups_router
app.include_router(backups_router.router)
