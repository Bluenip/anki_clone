"""Out-of-sample recall metrics, never applied to live card state."""
import json
import math
import subprocess
import sys
from pathlib import Path


def evaluate(items, parameters, baseline=None):
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), '--worker'], input=json.dumps({'items': items, 'parameters': parameters, 'baseline': baseline}), text=True, capture_output=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise ValueError('FSRS evaluation exceeded two minutes') from None
    if result.returncode: raise ValueError('FSRS evaluation failed; no settings were changed')
    return json.loads(result.stdout)


def metrics(items, parameters):
    from datetime import datetime, timedelta, timezone
    from fsrs import Scheduler, Card, Rating
    scheduler = Scheduler(**({'parameters': parameters} if parameters else {}), learning_steps=(), relearning_steps=(), enable_fuzzing=False)
    observations = []
    for history in items:
        if len(history) < 2: continue
        now = datetime(2000, 1, 1, tzinfo=timezone.utc)
        card = Card()
        for review in history[:-1]:
            now += timedelta(days=review['delta_t'])
            card, _ = scheduler.review_card(card, Rating(review['rating']), review_datetime=now)
        now += timedelta(days=history[-1]['delta_t'])
        prediction = max(1e-6, min(1 - 1e-6, scheduler.get_card_retrievability(card, now)))
        observations.append((prediction, int(history[-1]['rating'] > 1)))
    if not observations: return None
    count = len(observations)
    return {'samples': count, 'log_loss': -sum(y * math.log(p) + (1-y) * math.log(1-p) for p,y in observations) / count,
            'brier_score': sum((p-y)**2 for p,y in observations) / count,
            'predicted_recall': sum(p for p,y in observations) / count, 'observed_recall': sum(y for p,y in observations) / count}


if __name__ == '__main__':
    data = json.load(sys.stdin)
    print(json.dumps({'baseline': metrics(data['items'], data['baseline']), 'optimized': metrics(data['items'], data['parameters'])}))
