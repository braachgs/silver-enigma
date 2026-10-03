"""Generate mlb-demo-game.json: a synthetic game in MLB's live feed format.

Fictional players on real club names, simulated pitch by pitch, with field
names matching statsapi.mlb.com/api/v1.1/game/{pk}/feed/live. Used by the
app's offline demo and the tests.

    python3 tools/make_mlb_demo.py > mlb-demo-game.json
"""
import json
import random
import sys
from datetime import datetime, timedelta, timezone

AWAY = {"id": 111, "name": "Boston Red Sox", "teamName": "Red Sox", "abbreviation": "BOS", "teamCode": "bos"}
HOME = {"id": 141, "name": "Toronto Blue Jays", "teamName": "Blue Jays", "abbreviation": "TOR", "teamCode": "tor"}

LINEUPS = {
    "away": ["Danny Whitcomb", "Luis Arroyo", "Mike Kowalski", "Tyler Brennan", "Jose Villanueva",
             "Chris Hadley", "Sam Okafor", "Ricky Delgado", "Ben Lacroix"],
    "home": ["Marcus Bell", "Andre Tremblay", "Kenji Morita", "Jake Hollis", "Victor Quintero",
             "Nate Sorensen", "Eli Fontaine", "Cody Rampart", "Owen MacLeod"],
}
PITCHERS = {
    "away": [("Garrett Pike", "R", [("FF", "Four-Seam Fastball", 95), ("SL", "Slider", 86), ("CH", "Changeup", 87)]),
             ("Rafael Ortiz", "L", [("SI", "Sinker", 96), ("SL", "Slider", 88)])],
    "home": [("Liam Castellano", "R", [("FF", "Four-Seam Fastball", 97), ("CU", "Curveball", 81), ("CH", "Changeup", 88)]),
             ("Dmitri Volkov", "R", [("FF", "Four-Seam Fastball", 98), ("SL", "Slider", 89)])],
}

pid = 680000
players, ids = {}, {}


def person(name, pos="", side=""):
    global pid
    pid += 1
    first, last = name.split(" ", 1)
    players[f"ID{pid}"] = {"id": pid, "fullName": name, "firstName": first, "lastName": last,
                           "primaryPosition": {"abbreviation": pos}}
    ids[name] = pid
    return {"id": pid, "fullName": name}


for side in ("away", "home"):
    for n in LINEUPS[side]:
        person(n)
    for n, hand, _ in PITCHERS[side]:
        person(n, "P")


def ref(name):
    return {"id": ids[name], "fullName": name}


def simulate(seed):
    rng = random.Random(seed)
    clock = datetime(2026, 10, 3, 23, 8, tzinfo=timezone.utc)
    iso = lambda t: t.isoformat().replace("+00:00", "Z")
    plays = []
    score = {"away": 0, "home": 0}
    hr_count = {}
    order = {"away": 0, "home": 0}
    pitcher_idx = {"away": 0, "home": 0}
    pitch_count = {"away": 0, "home": 0}
    ab_index = 0

    def tick(lo, hi):
        nonlocal clock
        clock += timedelta(seconds=rng.randint(lo, hi))
        return clock

    inning = 1
    while True:
        for top in (True, False):
            bat = "away" if top else "home"
            fld = "home" if top else "away"
            if not top and inning >= 9 and score["home"] > score["away"]:
                return plays, score, hr_count
            outs = 0
            bases = {"1B": None, "2B": None, "3B": None}
            tick(100, 150)  # between halves
            first_ab_of_half = True
            while outs < 3:
                batter = LINEUPS[bat][order[bat] % 9]
                order[bat] += 1
                events = []
                runners = []
                start_time = tick(10, 25)
                # Pitching change at the start of a half once the starter tires.
                if first_ab_of_half and pitcher_idx[fld] == 0 and pitch_count[fld] > 92:
                    old, new = PITCHERS[fld][0][0], PITCHERS[fld][1][0]
                    pitcher_idx[fld] = 1
                    events.append({"index": 0, "type": "action", "isPitch": False, "startTime": iso(tick(60, 120)),
                                   "endTime": iso(clock), "count": {"balls": 0, "strikes": 0, "outs": outs},
                                   "details": {"event": "Pitching Substitution", "eventType": "pitching_substitution",
                                               "description": f"Pitching Change: {new} replaces {old}."}})
                first_ab_of_half = False
                pname, hand, arsenal = PITCHERS[fld][pitcher_idx[fld]]
                balls = strikes = 0
                result = None
                pitch_no = 0
                hit_data = None
                while result is None:
                    # Occasional steal attempt between pitches.
                    if bases["1B"] and not bases["2B"] and outs < 2 and rng.random() < 0.035:
                        runner = bases["1B"]
                        idx = len(events)
                        t = iso(tick(15, 25))
                        safe = rng.random() < 0.75
                        if safe:
                            desc = f"{runner} steals (1) 2nd base."
                            et, ev = "stolen_base_2b", "Stolen Base 2B"
                            bases["2B"], bases["1B"] = runner, None
                        else:
                            desc = f"{runner} caught stealing 2nd base, catcher to shortstop."
                            et, ev = "caught_stealing_2b", "Caught Stealing 2B"
                            bases["1B"] = None
                            outs += 1
                        events.append({"index": idx, "type": "action", "isPitch": False, "startTime": t, "endTime": t,
                                       "count": {"balls": balls, "strikes": strikes, "outs": outs},
                                       "details": {"event": ev, "eventType": et, "description": desc}})
                        runners.append({"movement": {"start": "1B", "end": None if not safe else "2B", "isOut": not safe,
                                                     "outBase": None if safe else "2B"},
                                        "details": {"event": ev, "eventType": et, "runner": ref(runner),
                                                    "isScoringEvent": False, "playIndex": idx}})
                        if outs >= 3:
                            break
                    pitch_no += 1
                    pitch_count[fld] += 1
                    code, ptype, velo = rng.choice(arsenal)
                    speed = round(velo + rng.uniform(-2, 2), 1)
                    r = rng.random()
                    pz = rng.uniform(1.8, 3.2)
                    if r < 0.36:
                        call, ccode = "Ball", "B"
                        pz = rng.choice([rng.uniform(3.6, 4.4), rng.uniform(0.6, 1.4), rng.uniform(1.8, 3.2)])
                        balls += 1
                    elif r < 0.53:
                        call, ccode = "Called Strike", "C"
                        strikes += 1
                    elif r < 0.64:
                        call, ccode = "Swinging Strike", "S"
                        strikes += 1
                    elif r < 0.81:
                        call, ccode = "Foul", "F"
                        strikes = min(2, strikes + 1)
                    else:
                        call, ccode = "In play, out(s)", "X"
                    pe = {"index": len(events), "pitchNumber": pitch_no, "isPitch": True, "type": "pitch",
                          "startTime": iso(tick(18, 28)), "endTime": iso(clock),
                          "details": {"call": {"code": ccode, "description": call}, "description": call, "code": ccode,
                                      "isInPlay": ccode == "X", "isStrike": ccode in "CSF", "isBall": ccode == "B",
                                      "type": {"code": code, "description": ptype}},
                          "count": {"balls": min(balls, 3) if balls < 4 else 4, "strikes": min(strikes, 2) if strikes < 3 else 3, "outs": outs},
                          "pitchData": {"startSpeed": speed, "endSpeed": round(speed - 8, 1), "strikeZoneTop": 3.4,
                                        "strikeZoneBottom": 1.6, "coordinates": {"pX": round(rng.uniform(-1, 1), 2), "pZ": round(pz, 2)}}}
                    events.append(pe)
                    if balls == 4:
                        result = "walk"
                    elif strikes == 3:
                        result = "strikeout"
                    elif ccode == "X":
                        x = rng.random()
                        result = ("home_run" if x < 0.055 else "triple" if x < 0.065 else "double" if x < 0.12
                                  else "single" if x < 0.32 else "out")
                        traj = {"home_run": "fly_ball", "triple": "line_drive", "double": "line_drive"}.get(result) or rng.choice(
                            ["ground_ball", "ground_ball", "fly_ball", "line_drive", "popup"])
                        ev_mph = round(rng.uniform(100, 112) if result == "home_run" else rng.uniform(70, 108), 1)
                        dist = rng.randint(380, 455) if result == "home_run" else rng.randint(120, 390) if traj != "ground_ball" else rng.randint(20, 160)
                        hit_data = {"launchSpeed": ev_mph, "launchAngle": rng.randint(22, 34) if traj == "fly_ball" else rng.randint(-10, 20),
                                    "totalDistance": dist, "trajectory": traj, "hardness": "hard" if ev_mph > 95 else "medium"}
                        pe["hitData"] = hit_data
                        if result != "out":
                            pe["details"]["call"]["description"] = pe["details"]["description"] = "In play, no out"
                if outs >= 3 and result is None:
                    # Inning ended on a caught stealing; batter's at-bat carries over in real games. Keep it simple: end here.
                    plays.append(make_play(ab_index, inning, top, batter, pname, hand, events, runners, None, score, outs,
                                           start_time, clock, iso, "caught_stealing_2b", events[-1]["details"]["description"]))
                    ab_index += 1
                    order[bat] -= 1
                    break

                full = batter
                desc_scores = []
                rbi = 0

                def advance(n, batter_end):
                    nonlocal rbi
                    moved = []
                    for b, nxt in (("3B", 4), ("2B", 3), ("1B", 2)):
                        r_ = bases[b]
                        if not r_:
                            continue
                        dest = int(b[0]) + n
                        end = "score" if dest >= 4 else f"{dest}B"
                        moved.append((r_, b, end))
                    for r_, b, end in moved:
                        bases[b] = None
                    for r_, b, end in moved:
                        if end == "score":
                            score[bat] += 1
                            rbi += 1
                            desc_scores.append(f"{r_} scores.")
                        else:
                            bases[end] = r_
                        runners.append({"movement": {"start": b, "end": end, "isOut": False},
                                        "details": {"event": result, "eventType": result, "runner": ref(r_),
                                                    "isScoringEvent": end == "score", "rbi": end == "score", "playIndex": len(events) - 1}})
                    if batter_end == "score":
                        score[bat] += 1
                        rbi += 1
                    else:
                        bases[batter_end] = batter
                    runners.append({"movement": {"start": None, "end": batter_end, "isOut": False},
                                    "details": {"event": result, "eventType": result, "runner": ref(batter),
                                                "isScoringEvent": batter_end == "score", "rbi": batter_end == "score",
                                                "playIndex": len(events) - 1}})

                def force_walk():
                    order_ = ["1B", "2B", "3B"]
                    carry = batter
                    for b in order_:
                        if bases[b] is None:
                            bases[b] = carry
                            runners.append({"movement": {"start": None if carry == batter else order_[order_.index(b) - 1], "end": b, "isOut": False},
                                            "details": {"event": "Walk", "eventType": "walk", "runner": ref(carry), "isScoringEvent": False, "playIndex": len(events) - 1}})
                            return
                        carry, bases[b] = bases[b], carry
                    score[bat] += 1
                    desc_scores.append(f"{carry} scores.")
                    runners.append({"movement": {"start": "3B", "end": "score", "isOut": False},
                                    "details": {"event": "Walk", "eventType": "walk", "runner": ref(carry), "isScoringEvent": True, "playIndex": len(events) - 1}})

                fielders = {"ground_ball": ["shortstop", "second baseman", "third baseman", "first baseman"],
                            "fly_ball": ["left fielder", "center fielder", "right fielder"],
                            "line_drive": ["left fielder", "center fielder", "shortstop", "second baseman"],
                            "popup": ["second baseman", "catcher", "first baseman", "shortstop"]}
                event_name = result
                if result == "walk":
                    force_walk()
                    desc = f"{full} walks."
                    event_name, ev_label = "walk", "Walk"
                elif result == "strikeout":
                    looking = events[-1]["details"]["call"]["code"] == "C"
                    outs += 1
                    desc = f"{full} {'called out on strikes' if looking else 'strikes out swinging'}."
                    ev_label = "Strikeout"
                elif result == "home_run":
                    hr_count[batter] = hr_count.get(batter, 0) + 1
                    field = rng.choice(["left field", "left center field", "center field", "right field"])
                    advance(4, "score")
                    desc = f"{full} homers ({hr_count[batter] + 20}) on a fly ball to {field}."
                    ev_label = "Home Run"
                elif result in ("single", "double", "triple"):
                    n = {"single": 1, "double": 2, "triple": 3}[result]
                    traj = hit_data["trajectory"].replace("_", " ")
                    advance(n, f"{n}B")
                    verb = {"single": "singles", "double": "doubles", "triple": "triples"}[result]
                    desc = f"{full} {verb} on a {traj} to {rng.choice(['left', 'center', 'right'])} fielder."
                    ev_label = result.capitalize()
                else:
                    traj = hit_data["trajectory"]
                    fielder = rng.choice(fielders[traj])
                    if traj == "ground_ball" and bases["1B"] and outs < 2 and rng.random() < 0.45:
                        lead = bases["1B"]
                        bases["1B"] = None
                        outs += 2
                        event_name, ev_label = "grounded_into_double_play", "Grounded Into DP"
                        desc = f"{full} grounds into a double play, {fielder} to second baseman to first baseman. {lead} out at 2nd."
                        runners.append({"movement": {"start": "1B", "end": None, "isOut": True, "outBase": "2B"},
                                        "details": {"event": ev_label, "eventType": event_name, "runner": ref(lead), "isScoringEvent": False, "playIndex": len(events) - 1}})
                    elif traj == "fly_ball" and bases["3B"] and outs < 2 and rng.random() < 0.8:
                        runner3 = bases["3B"]
                        bases["3B"] = None
                        outs += 1
                        score[bat] += 1
                        rbi = 1
                        event_name, ev_label = "sac_fly", "Sac Fly"
                        desc = f"{full} out on a sacrifice fly to {fielder}."
                        desc_scores.append(f"{runner3} scores.")
                        runners.append({"movement": {"start": "3B", "end": "score", "isOut": False},
                                        "details": {"event": ev_label, "eventType": event_name, "runner": ref(runner3), "isScoringEvent": True, "playIndex": len(events) - 1}})
                    else:
                        outs += 1
                        event_name, ev_label = "field_out", "Groundout" if traj == "ground_ball" else "Flyout" if traj == "fly_ball" else "Lineout" if traj == "line_drive" else "Pop Out"
                        verb = {"ground_ball": "grounds out to", "fly_ball": "flies out to", "line_drive": "lines out to", "popup": "pops out to"}[traj]
                        desc = f"{full} {verb} {fielder}."
                    runners.append({"movement": {"start": None, "end": None, "isOut": True, "outBase": "1B"},
                                    "details": {"event": ev_label, "eventType": event_name, "runner": ref(batter), "isScoringEvent": False, "playIndex": len(events) - 1}})
                if desc_scores:
                    desc = desc + " " + " ".join(desc_scores)
                plays.append(make_play(ab_index, inning, top, batter, pname, hand, events, runners, event_name, score, outs,
                                       start_time, clock, iso, ev_label, desc, rbi))
                ab_index += 1
                # Walk-off.
                if not top and inning >= 9 and score["home"] > score["away"]:
                    return plays, score, hr_count
        if inning >= 9 and score["home"] != score["away"]:
            return plays, score, hr_count
        inning += 1
        if inning > 11:
            return plays, score, hr_count


def make_play(ab, inning, top, batter, pitcher, hand, events, runners, event_type, score, outs, start, end, iso, label, desc, rbi=0):
    last = events[-1]["count"] if events else {"balls": 0, "strikes": 0}
    return {
        "result": {"type": "atBat", "event": label, "eventType": event_type or label, "description": desc, "rbi": rbi,
                   "awayScore": score["away"], "homeScore": score["home"], "isOut": False},
        "about": {"atBatIndex": ab, "halfInning": "top" if top else "bottom", "isTopInning": top, "inning": inning,
                  "startTime": iso(start), "endTime": iso(end), "isComplete": True,
                  "isScoringPlay": any(r["details"]["isScoringEvent"] for r in runners), "hasOut": outs > 0},
        "count": {"balls": min(last["balls"], 3), "strikes": min(last["strikes"], 2), "outs": outs},
        "matchup": {"batter": ref(batter), "batSide": {"code": "R"}, "pitcher": ref(pitcher), "pitchHand": {"code": hand}},
        "playEvents": events, "runners": runners, "atBatIndex": ab, "playEndTime": iso(end),
    }


def interesting(plays, score, hrs):
    runs = score["away"] + score["home"]
    last = plays[-1]
    walkoff = not last["about"]["isTopInning"] and last["about"]["inning"] >= 9 and last["about"]["isScoringPlay"]
    return 6 <= runs <= 11 and abs(score["away"] - score["home"]) <= 2 and sum(hrs.values()) >= 2 and walkoff \
        and last["about"]["inning"] == 9


seed = int(sys.argv[1]) if len(sys.argv) > 1 else None
if seed is None:
    seed = next(s for s in range(1, 5000) if interesting(*simulate(s)))
players_snapshot = dict(players)
plays, score, _ = simulate(seed)
print(json.dumps({
    "gamePk": 990001, "_demoSeed": seed,
    "gameData": {
        "game": {"pk": 990001, "type": "D"},
        "status": {"abstractGameState": "Final", "detailedState": "Final"},
        "teams": {"away": AWAY, "home": HOME},
        "players": players_snapshot,
        "venue": {"name": "the Dome"},
    },
    "liveData": {"plays": {"allPlays": plays}},
}, indent=1))
