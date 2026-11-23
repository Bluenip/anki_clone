import logging
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from database import Base, SessionLocal, engine
from deck_hierarchy import repair_missing_parents
from routers import (
    apkg_router,
    auth_router,
    backups_router,
    cards_router,
    decks_router,
    filtered_router,
    import_jobs_router,
    media_router,
    note_types_router,
    notes_router,
    optimizer_router,
    options_router,
    shared_router,
    stats_router,
    study_router,
    tts_router,
)

logger = logging.getLogger(__name__)


def prepare_database():
    """Create missing tables and indexes, then run best-effort data repairs."""
    Base.metadata.create_all(bind=engine)
    # create_all only builds indexes together with a new table; add ones declared later to existing tables.
    for table in Base.metadata.sorted_tables:
        for index in table.indexes:
            index.create(bind=engine, checkfirst=True)

    # Older imports stored child names without their empty parent deck records.
    try:
        with SessionLocal() as hierarchy_db:
            repair_missing_parents(hierarchy_db)
            hierarchy_db.commit()
    except Exception:
        logger.exception("Deck hierarchy repair failed; starting without it")


prepare_database()

app = FastAPI(
    title="AnkiClone API",
    description="Spaced Repetition Flashcard Platform API",
    version="1.0.0",
)

MEDIA_DIR = os.getenv("MEDIA_DIR", os.path.join(os.path.dirname(__file__), "media"))
os.makedirs(MEDIA_DIR, exist_ok=True)

# The browser reaches the API through the same origin (nginx proxy); list extra origins only for dev servers.
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
    expose_headers=["X-Total-Count"],
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # setdefault: a response with a stricter policy of its own (media files) keeps it.
    response.headers.setdefault("Content-Security-Policy", (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data: blob: https:; "
        "media-src 'self' data: blob: https:; "
        "connect-src 'self' http: https: ws: wss:;"
    ))
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


# Registration order matters where prefixes overlap: keep it as it was.
for module in (
    auth_router,
    decks_router,
    cards_router,
    study_router,
    shared_router,
    apkg_router,
    notes_router,
    options_router,
):
    app.include_router(module.router)

from routers import media_files_router
app.include_router(media_files_router.router)  # media needs a signed-in owner


@app.get("/")
def root():
    return {"message": "AnkiClone API is running", "docs": "/docs"}


for module in (
    filtered_router,
    stats_router,
    note_types_router,
    tts_router,
    media_router,
    optimizer_router,
    backups_router,
    import_jobs_router,
):
    app.include_router(module.router)
