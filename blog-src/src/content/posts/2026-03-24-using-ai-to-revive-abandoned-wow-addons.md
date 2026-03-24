---
title: "Using AI to Revive Abandoned WoW Addons (And Why You Should Ship What You Build)"
date: 2026-03-24
category: "dev-session"
tags:
  [
    "world-of-warcraft",
    "ai-development",
    "claude-code",
    "lua",
    "wow-addons",
    "gaming",
  ]
excerpt: "When your favorite WoW addons break and the original authors have moved on, AI turns out to be a surprisingly capable Lua partner — even if you don't fully understand the WoW API yourself."
---

If you've played World of Warcraft for any length of time, you know the drill. A new expansion drops, APIs change, and half your addon list lights up with errors. The authors have moved on. The GitHub repos haven't seen a commit in two years. You're left choosing between playing without features you've relied on for a decade or figuring it out yourself.

I chose the third option: figuring it out with AI.

## The Problem With Abandoned Addons

WoW's Midnight expansion brought significant changes to the addon API. Blizzard restructured how addons interact with protected functions, introduced secret values for spell data, and tightened restrictions on what addons can do during combat. Addons that worked fine in The War Within suddenly started throwing `ADDON_ACTION_FORBIDDEN` errors left and right.

Two addons I depended on were hit hard:

**Miks Scrolling Battle Text** — a scrolling combat text addon that displays damage, heals, and cooldowns in customizable scroll areas. It was throwing protected function errors because it tried to call `Frame:RegisterEvent()` during combat lockdown — something WoW's security model no longer allows.

**CantHealYou** — a healer addon that automatically whispers party members when it can't heal them (out of range, line of sight, interrupted). It called `SendChatMessage()` in response to game events, which Blizzard now blocks to prevent automation abuse.

Both addons were well-written. Both had active users. Neither had an active maintainer.

## AI as Your Lua Pair Programmer

Here's what surprised me: I don't deeply understand WoW's Lua API. I know enough to read addon code and roughly follow what's happening, but I couldn't write a combat log parser from scratch. That's where Claude came in.

The workflow looked like this: I'd describe the error I was seeing in-game, paste the BugGrabber output, and Claude would trace through the addon code to find the root cause. For KBST, it identified that `InCombatLockdown()` wasn't sufficient as a guard — WoW has multiple protected states beyond combat (loading screens, cinematics, vehicle transitions) where `InCombatLockdown()` returns false but protected functions still can't be called.

That's the kind of insight that would've taken me hours of forum-diving to piece together. Claude found it by reading the code and reasoning about the API behavior.

For CantHealYou, the fix was architectural. The addon's entire event-driven design — automatically sending chat messages when healing spells fail — violated WoW's new stance on addon automation. The solution wasn't a one-line patch; it required rethinking how the addon communicates with players.

## Going Beyond Fixes

What started as "fix these errors" turned into something bigger. For KBST, we:

- Modernized the codebase to use WoW 12.0+ APIs (`C_Spell.GetSpellCooldown` with legacy fallbacks)
- Added proper secret value handling for Midnight's taint system
- Built a full v2.x roadmap across four phases — stability, features, differentiation, and community
- Analyzed the entire architecture: 146 functions across 19 files organized into Core, Parser, and UI modules

I even experimented with a multi-agent setup where different AI agents played different roles — a CEO agent for roadmap planning, a founding engineer for implementation, and a QA engineer for testing. It was partly an experiment in AI coordination and partly just fun to watch AI agents argue about hiring priorities for a WoW addon project.

## Ship Your Stuff

Here's the thing I want to leave you with: **ship what you build.**

When I uploaded my updated versions, I started hearing from other players who'd been dealing with the same broken addons. People who had the same errors, the same frustrations, and had either given up or were limping along with half-broken setups. My fixes weren't perfect. They were "good enough to stop the errors and get back to playing." But that's exactly what people needed.

There's a tendency — especially among developers — to hold things back until they're polished. Until you've written tests. Until the code is clean. Until you fully understand every line. But the person getting `ADDON_ACTION_FORBIDDEN` errors every time they open a vendor doesn't care about your test coverage. They care that the addon works again.

If you've fixed something for yourself, there's a very good chance someone else needs that fix too. Put it on CurseForge. Push it to GitHub. Post it on the addon's abandoned issue tracker. The WoW addon community is smaller than it used to be, and every maintained addon matters.

## AI + Niche Domains = Underrated Combo

The broader takeaway: AI-assisted development isn't just for web apps and CRUD APIs. It works remarkably well in niche domains where documentation is scattered, tribal knowledge lives in decade-old forum posts, and the codebase is in a language you don't use daily.

WoW addon development in Lua is exactly that kind of domain. The API docs are on wowpedia. The real knowledge is buried in years of addon author experience. And the problems are real engineering problems — event-driven architecture, state management, security models, performance under load.

If you're a developer who plays WoW, or a WoW player who codes, give it a try. Pick an abandoned addon you miss, point an AI at the error log, and see what happens. You might be surprised how far you get — and how many people thank you for shipping it.
