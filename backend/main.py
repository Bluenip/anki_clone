from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from database import engine, Base
from routers import auth_router, decks_router, cards_router, study_router, shared_router

# Create all tables
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="AnkiClone API",
    description="Spaced Repetition Flashcard Platform API",
    version="1.0.0",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers
app.include_router(auth_router.router)
app.include_router(decks_router.router)
app.include_router(cards_router.router)
app.include_router(study_router.router)
app.include_router(shared_router.router)


@app.get("/")
def root():
    return {"message": "AnkiClone API is running", "docs": "/docs"}
