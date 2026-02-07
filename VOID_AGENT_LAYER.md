# The Void × Kaneo — Agent Layer Development Plan

## Build Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Schema migration (skill, project_document, task extensions) | ✅ Done | Migration `0012_void_agent_layer_schema.sql` applied to Docker Postgres. Verified tables + columns. |
| 2 | API endpoints (skills CRUD, project docs CRUD, task extensions) | ✅ Done | Native dev running (Docker Postgres + local API/web). All endpoints live. |
| 3 | Task detail UI (PR link, preview link, skill dropdown, context viewer) | ✅ Done | Skill dropdown, PR/preview links, context payload viewer all working. |
| 4 | Project Overview page (files, skills, documents, viewer modal) | ✅ Done | Full page with docs/skills CRUD, modals, context preview. Nav updated. |
| 5 | Pre-work fields (understanding, success_criteria, verification_plan, approach) | ✅ Done | Collapsible pre-work section with 4 textarea fields, debounced save, auto-expand on content. |
| 6 | Comment @mention notification routing | ✅ Done | Name-based @mentions (@shade/@smoke/@nav), parsed from comments, creates in-app notifications via Kaneo notification table. |
| 7 | Remove Project Chat terminal UI | ✅ Skipped | New Kaneo build doesn't have chat — Slack is the chat surface. Nothing to remove. |
| 8 | Cloudflare Tunnel switchover (void.tycho.ca → Kaneo) | ✅ Done | Tunnel routes /api/* → :1337, everything else → :5173. void.tycho.ca now serves Kaneo. |

**Phase 1 complete.** All tasks done. Dev server running behind Cloudflare Tunnel at void.tycho.ca. Next: Nav QA, then Phase 2 (OpenClaw plugin integration).

**Infra fixes (Feb 5):**
- CF Access removed from void.tycho.ca (was blocking SPA API calls)
- Tunnel regex fixed: `^/api/.*` (was `/api.*` which matched pnpm `api-key` paths)
- Stale `dist/` deleted, Vite sends `Cache-Control: no-store`
- Nav can now access void.tycho.ca cleanly (Kaneo login page)

**Next phase: Meta Ads Features** (after Phase 1 QA)
- Creative Gallery + Quick Approval (R2 storage, not bytea)
- Task Approval Actions
- Task Labels + Board Filters
- Spec: `docs/void-spec-meta-ads-features.md`

**Security audit queued** — exposed ports, API auth, DB access, tunnel config, secrets.

**Note:** Smoke building on native pnpm dev. Docker Postgres for DB. Vite + API both on 0.0.0.0 for Tailscale access. Git push blocked (no HTTPS auth on Mac Mini).

## What We're Building

Kaneo is a solid open-source PM tool. We're customizing it into **The Void** — an AI agent command center that happens to also be a project management tool.

**Kaneo gives us for free:** Workspaces, projects, tasks, kanban boards, labels, comments/activities, time tracking, user auth (with SSO), API keys, notifications, GitHub integration (issues/PRs/webhooks), search, teams, task import/export, OpenAPI docs.

**We're adding:** The agent orchestration layer — everything that makes this an AI-native workspace instead of just another PM tool.

---

## Architecture: Plugin-First

Kaneo has a **plugin system** (`apps/api/src/plugins/`) with an event bus. The GitHub integration is already built as a plugin. We build the OpenClaw integration the same way — as an `openclaw` plugin that:

- Listens to task events (created, assigned, status changed, comment created)
- Talks to OpenClaw gateways via HTTP
- Manages agent sessions per task/project
- Routes @mentions to active sessions

This means **core Kaneo stays clean** — all agent logic lives in the plugin, and we can upstream Kaneo updates without merge conflicts.

---

## Development Layers

### Layer 0: Foundation (Schema + Config)

**New database tables:**

```
agent_gateway                         # OpenClaw gateway connections
├── id
├── workspace_id → workspace
├── name (Shade, Smoke)
├── agent_type (orchestrator | executor)
├── base_url (http://100.115.23.74:18789)
├── auth_token (encrypted)
├── status (online | offline | unknown)
├── last_heartbeat
├── metadata (JSON — model, version, capabilities)
├── created_at, updated_at

agent_session                         # Active agent work sessions
├── id
├── gateway_id → agent_gateway
├── session_key (OpenClaw session key)
├── session_label (project:<id> | task:<id>)
├── session_type (project_chat | task_execution | ad_hoc)
├── task_id → task (nullable)
├── project_id → project (nullable)
├── status (active | completed | failed | stale)
├── token_usage (JSON — input, output, cost)
├── started_at, completed_at
├── created_at, updated_at

skill                                 # Reusable skill definitions
├── id
├── workspace_id → workspace
├── name
├── description
├── skill_path (/home/navee/clawd/skills/...)
├── icon
├── category (coding | marketing | research | ops)
├── created_at, updated_at

project_skill                         # Skills available per project
├── id
├── project_id → project
├── skill_id → skill
├── is_default (auto-inject into every task?)
├── created_at
```

**Extend existing tables:**

```sql
-- task table additions
ALTER TABLE task ADD COLUMN openclaw_session_key TEXT;
ALTER TABLE task ADD COLUMN skill_id TEXT REFERENCES skill(id);
ALTER TABLE task ADD COLUMN pre_work JSONB;
  -- { understanding, success_criteria, verification_plan, approach }
ALTER TABLE task ADD COLUMN completion_summary TEXT;
ALTER TABLE task ADD COLUMN blocked_reason TEXT;

-- project table additions
ALTER TABLE project ADD COLUMN repo_path TEXT;
ALTER TABLE project ADD COLUMN claude_md_path TEXT;
ALTER TABLE project ADD COLUMN default_gateway_id TEXT REFERENCES agent_gateway(id);
ALTER TABLE project ADD COLUMN project_chat_session_key TEXT;
```

---

### Layer 1: OpenClaw Plugin (`apps/api/src/plugins/openclaw/`)

The core integration. Built as a Kaneo plugin following the same pattern as GitHub.

```
plugins/openclaw/
├── index.ts              # Plugin registration + init
├── config.ts             # Gateway connection config
├── types.ts              # OpenClaw-specific types
├── services/
│   ├── gateway-client.ts     # HTTP client for OpenClaw API
│   ├── session-manager.ts    # Create/track/poll sessions
│   ├── dispatch-service.ts   # Task → agent dispatch logic
│   └── context-builder.ts    # Build context payloads for agents
├── events/
│   ├── task-assigned.ts      # On assign → dispatch to agent
│   ├── task-comment-created.ts  # @mention → route to session
│   ├── task-status-changed.ts   # Status changes → notify/update
│   └── task-created.ts      # Auto-assign if rules match
└── webhook-handler.ts    # Receive callbacks FROM agents
```

**Key flows:**

#### Task Dispatch (assign → agent starts working)
```
1. User assigns task to agent (or auto-assign rule fires)
2. Plugin event: task.assignee_changed
3. dispatch-service builds context payload:
   - Task: title, description, acceptance criteria, labels
   - Project: CLAUDE.md path, repo path, description
   - Skills: task skill + project default skills
   - Pre-work template: 4 fields to fill out
   - Comments: recent thread for context
   - Completion protocol: TASK_COMPLETE:{taskId}
4. gateway-client calls sessions_spawn on target gateway
   - label: task:{taskId}
   - cleanup: keep
5. Store session_key on task + create agent_session record
6. Task status → "in_progress"
```

#### Context Payload (what the agent receives)
```markdown
## Task: {title}
ID: {taskId} | Priority: {priority} | Project: {projectName}

### Description
{description}

### Pre-Work (fill these out before starting)
- **Understanding:** What is being asked?
- **Success Criteria:** How will you know it's done?
- **Verification Plan:** How will you verify it works?
- **Approach:** What's your plan?

### Project Context
- Repo: {repoPath}
- CLAUDE.md: {claudeMdPath}
- Read the project's CLAUDE.md first for rules and conventions.

### Skills
{skillInstructions — loaded from skill_path}

### Recent Comments
{last 5 comments for context}

### Completion Protocol
When done, include: TASK_COMPLETE:{taskId}
If blocked: TASK_BLOCKED:{taskId} {reason}
To update pre-work: POST to {apiUrl}/api/task/{taskId}/pre-work
```

#### Comment @Mention Routing
```
1. User or agent posts comment with @shade or @smoke
2. Plugin event: task.comment_created
3. Parse @mentions from comment text
4. Look up agent_gateway for mentioned agent
5. If task has active session → sessions_send to that session
6. If no session → create new session (re-dispatch)
7. Agent reply → POST back as new comment via API key
```

#### Completion Detection
```
1. Poll agent sessions every 30s (or webhook callback)
2. Check session history for TASK_COMPLETE:{taskId}
3. Extract completion summary (text after marker)
4. Update task: status → "done", completion_summary
5. Update agent_session: status → "completed"
6. Create notification for task creator
7. Check TASK_BLOCKED:{taskId} markers too
```

#### Agent Callback Webhook (`/api/openclaw/webhook`)
```
Agents can POST directly to Kaneo to:
- Update pre-work fields
- Post comments
- Change task status
- Report completion/blockers
- Request more context

Auth: API key (generated per agent gateway)
```

---

### Layer 2: Project Chat (`apps/web/src/routes/.../project-chat.tsx`)

Terminal-style chat UI scoped per project. This is the "talk to the orchestrator" surface.

**How it works:**
- Each project gets a dedicated session: `project:{projectId}`
- First message → `sessions_spawn` with project context seed
- Subsequent messages → `sessions_send` to existing session
- Poll session history for responses
- Show tool calls inline (collapsible, syntax highlighted)

**UI:**
```
┌─────────────────────────────────────────────────────────────┐
│ ● ● ●   shade@switch-dashboard ~ project chat               │
├─────────────────────────────────────────────────────────────┤
│ $ analyze our landing page conversion rates                 │
│                                                             │
│ → [tool:read] ~/clawd/switch-dashboard/CLAUDE.md           │
│ → [tool:web_fetch] https://switchresearch.com/...          │
│ → [tool:exec] node scripts/analyze-conversions.js          │
│                                                             │
│ Here's what I found: ...                                    │
│                                                             │
│ $ _                                                         │
└─────────────────────────────────────────────────────────────┘
```

**Slash commands (server-side):**
- `/new` — clear session, spawn fresh
- `/clear` — clear local history only
- `/status` — session status card (model, tokens, cost)
- `/model [name]` — switch model for this session
- `/sessions` — list recent sessions

**API routes (new in Kaneo):**
```
POST /api/project-chat/:projectId/send     — send message / spawn session
GET  /api/project-chat/:projectId/history   — poll session history
POST /api/project-chat/:projectId/command   — slash commands
POST /api/project-chat/:projectId/upload    — image paste
```

---

### Layer 3: Agent Dashboard Views

New pages in the web app under a top-level "Agents" section.

#### 3a. Agent Status Overview
```
/dashboard/workspace/:id/agents
```
- Cards per gateway (Shade, Smoke)
- Online/offline status (heartbeat polling)
- Current activity (idle / working on task X)
- Model, version, uptime
- Quick actions: restart, view config, view sessions

#### 3b. Session Monitor
```
/dashboard/workspace/:id/agents/:gatewayId/sessions
```
- List active sessions with labels
- Click session → live message feed (2s polling)
- Tool call visibility (expandable blocks)
- Session status card (tokens, cost, model)

#### 3c. Live Feed
```
/dashboard/workspace/:id/feed
```
- Terminal-style event stream across all agents
- Events: task dispatched, task completed, agent started, error, etc.
- Filterable by agent, project, event type
- Real-time (polling or future WebSocket)

#### 3d. Agent Configuration
```
/dashboard/workspace/:id/agents/:gatewayId/config
```
- View/edit gateway config (via `gateway` tool: `config.get`, `config.patch`)
- Model settings, channel config, tool policies
- Cron jobs management (list, add, edit, delete, run)
- Skills list (from filesystem scan)

---

### Layer 4: Skills System

Skills are reusable instruction sets that can be attached to projects or individual tasks.

#### Skills Browser
```
/dashboard/workspace/:id/skills
```
- Scan `~/clawd/skills/` directory
- Show name, description, category
- One-click attach to project (creates `project_skill` record)
- Preview skill instructions

#### Task Skill Picker
In task detail view:
- Dropdown to select a skill
- Shows skill description
- Skill instructions injected into dispatch payload

#### Project Default Skills
In project settings:
- List of skills auto-attached to every new task
- Useful for project-specific coding standards, copy guidelines, etc.

---

### Layer 5: OpenClaw Control Panel

Full control surface for managing OpenClaw gateways.

#### 5a. Memory Viewer
```
/dashboard/workspace/:id/agents/:gatewayId/memory
```
- Browse MEMORY.md, daily memory files (`memory/YYYY-MM-DD.md`)
- Inline editor with save
- Search across memory (via `memory_search` tool)

#### 5b. Usage & Cost Tracking
```
/dashboard/workspace/:id/usage
```
- Per-gateway usage cards
- Per-session cost breakdown
- Provider breakdown (Anthropic, OpenAI, etc.)
- Daily/weekly/monthly trends
- Data from `session_status` tool

#### 5c. Crons Manager
```
/dashboard/workspace/:id/agents/:gatewayId/crons
```
- List all cron jobs
- Create/edit/delete crons
- Run job immediately
- View run history
- Data from `cron` tool

#### 5d. Workspace Explorer
```
/dashboard/workspace/:id/agents/:gatewayId/files
```
- Browse agent workspace filesystem
- File viewer with syntax highlighting
- Edit capability for .md, .json, config files

---

## Development Phases

### Phase 1: Core Agent Integration (Week 1-2)
**Goal:** Tasks can be dispatched to agents and completed automatically.

1. Schema extensions (agent_gateway, agent_session, task columns)
2. OpenClaw plugin skeleton (gateway-client, session-manager)
3. Task dispatch flow (assign → spawn session → track)
4. Completion detection (poll for TASK_COMPLETE marker)
5. Agent users in Kaneo (Shade + Smoke as team members)
6. API key generation for agent callbacks
7. Basic agent status cards (online/offline)

**Deliverable:** Assign task to Shade in Kaneo UI → Shade gets context + works → task auto-completes.

### Phase 2: Project Chat + Live Feed (Week 2-3)
**Goal:** Real-time conversation with agents per project.

1. Project Chat UI (terminal aesthetic)
2. Session spawn/send API routes
3. History polling with tool call rendering
4. Slash commands (/new, /status, /model)
5. Live Feed component (cross-agent event stream)
6. Image paste in chat

**Deliverable:** Click into project → terminal chat → talk to Shade with full project context.

### Phase 3: @Mentions + Comments Routing (Week 3)
**Goal:** Comments in task detail route to agent sessions.

1. @mention parsing in comments
2. Route mentions to active task sessions
3. Agent replies posted back as comments
4. Pre-work field UI in task detail
5. Agent fills pre-work via API callback

**Deliverable:** Post "@shade what's the status?" on a task → Shade replies in thread.

### Phase 4: Skills System (Week 3-4)
**Goal:** Skills browseable and attachable to projects/tasks.

1. Skills table + project_skill junction
2. Filesystem scanner for installed skills
3. Skills browser page
4. Task skill picker (dropdown in task detail)
5. Project default skills (settings page)
6. Skill instructions injected into dispatch payload

**Deliverable:** Attach "switch-copywriting" skill to Switch project → all tasks get copy guidelines.

### Phase 5: OpenClaw Control Panel (Week 4-5)
**Goal:** Full gateway management from the dashboard.

1. Gateway config viewer/editor
2. Crons manager (CRUD + run + history)
3. Memory viewer/editor
4. Session monitor (per-gateway session list + detail)
5. Usage/cost tracking dashboard
6. Model switcher per session

**Deliverable:** Manage everything about your agents from one UI.

### Phase 6: Polish + Migrate (Week 5-6)
**Goal:** Production-ready, old Void retired.

1. Migrate existing Void data (projects, tasks) to Kaneo
2. Cloudflare Tunnel pointed to Kaneo
3. Branding (The Void theme on Kaneo shell)
4. Notification center (agent completions, errors, blockers)
5. Command palette (⌘K)
6. Mobile responsiveness

---

## Data Migration Path

**From old Void (SQLite) → Kaneo (PostgreSQL):**

| Old Void | Kaneo |
|----------|-------|
| `projects` table | `project` table (add workspace_id, repo_path, claude_md_path) |
| `tasks` table | `task` table (add pre_work, skill_id, openclaw_session_key) |
| `task_comments` | `activity` table (type: "comment") |
| `task_events` | `activity` table (various types) |
| `agents` table | `agent_gateway` table + `user` table (agents as users) |
| `project_chat_messages` | N/A (sessions are in OpenClaw, history via polling) |

Migration script: read old SQLite → map IDs → insert into Kaneo PostgreSQL.

---

## How Agents Authenticate to Kaneo

Two paths:

1. **API Keys** (preferred) — Generate in Kaneo settings. Agent includes `Authorization: Bearer <key>` on API calls. Rate-limited, auditable.

2. **Plugin webhook** — Agents POST to `/api/openclaw/webhook` with a shared secret. Plugin handles auth internally.

Agents need to:
- Update task status
- Post comments (as themselves)
- Fill pre-work fields
- Report completion/blockers
- Read task details and context

All available through Kaneo's existing REST API + our new endpoints.

---

## What Kaneo Already Handles (don't rebuild)

- ✅ User auth + SSO
- ✅ Workspace/team management
- ✅ Project CRUD
- ✅ Task CRUD with kanban drag-drop
- ✅ Labels + priorities
- ✅ Comments/activities
- ✅ Time tracking
- ✅ GitHub integration (issues/PRs)
- ✅ Notifications
- ✅ Search
- ✅ API keys
- ✅ OpenAPI documentation
- ✅ Task import/export

**Don't rebuild these.** Extend them.
