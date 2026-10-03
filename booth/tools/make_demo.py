"""Generate demo-game.json: a synthetic game in the NHL play-by-play format.

Fictional players, real field names. Used by the app's offline Demo mode and
by the tests, so the booth can be tried without a live game or network.

    python3 tools/make_demo.py > demo-game.json
"""
import json
import random

random.seed(1993)

AWAY = {"id": 8, "abbrev": "MTL", "commonName": {"default": "Canadiens"}, "placeName": {"default": "Montréal"}}
HOME = {"id": 10, "abbrev": "TOR", "commonName": {"default": "Maple Leafs"}, "placeName": {"default": "Toronto"}}

ROSTERS = {
    8: [("Luc", "Bergeron", 91, "C"), ("Marc", "Tremblay", 14, "C"), ("Jean", "Gagnon", 27, "L"),
        ("Remi", "Dubois", 11, "R"), ("Andre", "Pelletier", 6, "D"), ("Yves", "Lachance", 44, "D"),
        ("Patrick", "Lapointe", 33, "G")],
    10: [("Doug", "McAllister", 16, "C"), ("Wade", "Kinnear", 17, "L"), ("Gord", "Halloran", 22, "R"),
         ("Terry", "Brodeur", 93, "C"), ("Dale", "Stewart", 4, "D"), ("Jim", "Corrigan", 34, "D"),
         ("Felix", "Ouellette", 29, "G")],
}

roster_spots = []
pid = 8470000
ids = {8: [], 10: []}
goalies = {}
for team, players in ROSTERS.items():
    for first, last, num, pos in players:
        pid += 1
        roster_spots.append({"teamId": team, "playerId": pid, "firstName": {"default": first},
                             "lastName": {"default": last}, "sweaterNumber": num, "positionCode": pos})
        if pos == "G":
            goalies[team] = pid
        else:
            ids[team].append(pid)

plays = []
event_id = 0
score = {8: 0, 10: 0}
sog = {8: 0, 10: 0}
goal_totals = {}


def mmss(sec):
    return f"{sec // 60:02d}:{sec % 60:02d}"


def add(period, t, type_key, details=None):
    global event_id
    event_id += 1
    plays.append({
        "eventId": event_id, "sortOrder": event_id,
        "periodDescriptor": {"number": period, "periodType": "REG"},
        "timeInPeriod": mmss(t), "timeRemaining": mmss(1200 - t),
        "typeDescKey": type_key, "details": details or {},
    })


def other(team):
    return 10 if team == 8 else 8


# Goals scripted so the game is close: (period, second, team)
GOALS = {(1, 412): 10, (1, 1011): 8, (2, 233): 8, (2, 905): 10, (3, 640): 8, (3, 1105): 10, (3, 1180): 10}
PENALTIES = {(1, 700): 8, (2, 520): 10, (3, 300): 8}
PEN_KEYS = ["hooking", "tripping", "interference", "high-sticking", "roughing", "slashing"]

for period in (1, 2, 3):
    add(period, 0, "period-start")
    t = 0
    owner = random.choice([8, 10])
    add(period, t, "faceoff", {"eventOwnerTeamId": owner, "winningPlayerId": ids[owner][0],
                               "losingPlayerId": ids[other(owner)][0], "zoneCode": "N"})
    while t < 1190:
        t += random.randint(12, 40)
        t = min(t, 1194)
        key = next(((p, s) for (p, s) in GOALS if p == period and s <= t), None)
        if key:
            team = GOALS.pop(key)
            t = key[1]
            shooter = random.choice(ids[team][:4])
            assists = random.sample([i for i in ids[team] if i != shooter], 2)
            score[team] += 1
            sog[team] += 1
            goal_totals[shooter] = goal_totals.get(shooter, 0) + 1
            add(period, t, "goal", {
                "eventOwnerTeamId": team, "scoringPlayerId": shooter, "scoringPlayerTotal": goal_totals[shooter] + 2,
                "assist1PlayerId": assists[0], "assist2PlayerId": assists[1],
                "goalieInNetId": goalies[other(team)], "shotType": random.choice(["wrist", "snap", "slap", "backhand", "tip-in"]),
                "zoneCode": "O", "awayScore": score[8], "homeScore": score[10], "awaySOG": sog[8], "homeSOG": sog[10]})
            winner = random.choice([8, 10])
            add(period, t, "faceoff", {"eventOwnerTeamId": winner, "winningPlayerId": ids[winner][0],
                                       "losingPlayerId": ids[other(winner)][0], "zoneCode": "N"})
            continue
        key = next(((p, s) for (p, s) in PENALTIES if p == period and s <= t), None)
        if key:
            team = PENALTIES.pop(key)
            t = key[1]
            add(period, t, "penalty", {"eventOwnerTeamId": team, "committedByPlayerId": random.choice(ids[team]),
                                       "drawnByPlayerId": random.choice(ids[other(team)]), "typeCode": "MIN",
                                       "descKey": random.choice(PEN_KEYS), "duration": 2, "zoneCode": "D"})
            add(period, t, "faceoff", {"eventOwnerTeamId": other(team), "winningPlayerId": ids[other(team)][1],
                                       "losingPlayerId": ids[team][1], "zoneCode": "O"})
            continue
        team = random.choice([8, 10])
        kind = random.choices(["shot-on-goal", "missed-shot", "blocked-shot", "hit", "giveaway", "takeaway", "stoppage"],
                              weights=[30, 14, 12, 18, 7, 7, 12])[0]
        if kind == "shot-on-goal":
            sog[team] += 1
            add(period, t, kind, {"eventOwnerTeamId": team, "shootingPlayerId": random.choice(ids[team]),
                                  "goalieInNetId": goalies[other(team)], "shotType": random.choice(["wrist", "snap", "slap", "backhand"]),
                                  "zoneCode": "O", "awaySOG": sog[8], "homeSOG": sog[10]})
        elif kind == "missed-shot":
            add(period, t, kind, {"eventOwnerTeamId": team, "shootingPlayerId": random.choice(ids[team]),
                                  "shotType": "wrist", "reason": random.choice(["wide-of-net", "high-and-wide", "hit-crossbar"]), "zoneCode": "O"})
        elif kind == "blocked-shot":
            add(period, t, kind, {"eventOwnerTeamId": other(team), "shootingPlayerId": random.choice(ids[team]),
                                  "blockingPlayerId": random.choice(ids[other(team)][4:6]), "zoneCode": "D"})
        elif kind == "hit":
            add(period, t, kind, {"eventOwnerTeamId": team, "hittingPlayerId": random.choice(ids[team]),
                                  "hitteePlayerId": random.choice(ids[other(team)]), "zoneCode": random.choice("ODN")})
        elif kind in ("giveaway", "takeaway"):
            add(period, t, kind, {"eventOwnerTeamId": team, "playerId": random.choice(ids[team]), "zoneCode": random.choice("ODN")})
        else:
            add(period, t, "stoppage", {"reason": random.choice(["offside", "icing", "puck-in-netting", "goalie-stopped-after-sog", "puck-frozen"])})
            winner = random.choice([8, 10])
            add(period, t, "faceoff", {"eventOwnerTeamId": winner, "winningPlayerId": ids[winner][random.randint(0, 3)],
                                       "losingPlayerId": ids[other(winner)][0], "zoneCode": random.choice("ODN")})
    add(period, 1200, "period-end")

add(3, 1200, "game-end")

AWAY.update({"score": score[8], "sog": sog[8]})
HOME.update({"score": score[10], "sog": sog[10]})
print(json.dumps({
    "id": 1993000001, "gameState": "OFF", "venue": {"default": "the Gardens"},
    "awayTeam": AWAY, "homeTeam": HOME, "rosterSpots": roster_spots, "plays": plays,
}, ensure_ascii=False, indent=1))
