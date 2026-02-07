# Void Build Spec - Overnight Build

## Overview
Extend Kaneo with agent-aware task management features. This is the foundation for The Void - our agent command center.

## Phase 1: Database Schema Changes

### 1.1 New `skill` table
```sql
skill (
  id TEXT PRIMARY KEY (cuid2),
  project_id TEXT NOT NULL FK → project.id CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  file_path TEXT,  -- path to skill file on disk
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)
INDEX: skill_projectId_idx ON (project_id)
```

### 1.2 New `project_document` table
```sql
project_document (
  id TEXT PRIMARY KEY (cuid2),
  project_id TEXT NOT NULL FK → project.id CASCADE,
  name TEXT NOT NULL,           -- e.g. "CLAUDE.md", "Roadmap"
  type TEXT NOT NULL DEFAULT 'file',  -- 'file', 'roadmap', 'notes'
  file_path TEXT,               -- path on disk (e.g. ~/clawd/switch-dashboard/CLAUDE.md)
  content TEXT,                 -- inline content (if no file_path)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)
INDEX: project_document_projectId_idx ON (project_id)
```

### 1.3 Extend `task` table
Add these columns:
- `skill_id TEXT` nullable, FK → skill.id SET NULL on delete
- `pr_link TEXT` nullable
- `preview_link TEXT` nullable
- `context_payload TEXT` nullable (JSON string - the context that would be/was sent to agent)

## Phase 2: API Backend

### 2.1 Skill routes (`apps/api/src/skill/`)
Following the existing pattern (controller + route):

- `GET /api/skill/:projectId` → List skills for project
- `POST /api/skill/:projectId` → Create skill (body: {name, description, filePath})
- `PUT /api/skill/:id` → Update skill
- `DELETE /api/skill/:id` → Delete skill

### 2.2 ProjectDocument routes (`apps/api/src/project-document/`)
- `GET /api/project-document/:projectId` → List documents for project
- `POST /api/project-document/:projectId` → Create document (body: {name, type, filePath, content})
- `PUT /api/project-document/:id` → Update document
- `DELETE /api/project-document/:id` → Delete document
- `GET /api/project-document/content/:id` → Get document content (reads file_path or returns content)

### 2.3 Update Task routes
Update the create/update task validators and controllers to accept:
- `skillId` (optional string)
- `prLink` (optional string)
- `previewLink` (optional string)
- `contextPayload` (optional string)

Add new single-field update endpoints:
- `PUT /api/task/skill/:id` → body: {skillId}
- `PUT /api/task/pr-link/:id` → body: {prLink}
- `PUT /api/task/preview-link/:id` → body: {previewLink}

### 2.4 Register new routes in `apps/api/src/index.ts`
Add skill, projectDocument to the api routes and AppType export.

## Phase 3: Frontend

### 3.1 Project Overview Page
New route: `apps/web/src/routes/_layout/_authenticated/dashboard/workspace/$workspaceId/project/$projectId/overview.tsx`

Layout:
```
┌─────────────────────────────────────────────┐
│ Project Name - Overview                      │
├──────────────────────┬──────────────────────┤
│ Documents            │ Skills               │
│ ┌──────────────────┐ │ ┌──────────────────┐ │
│ │ 📄 CLAUDE.md    │ │ │ 🛠️ coding-agent │ │
│ │ 📄 Roadmap      │ │ │ 🛠️ browser-use  │ │
│ │ + Add Document  │ │ │ + Add Skill      │ │
│ └──────────────────┘ │ └──────────────────┘ │
└──────────────────────┴──────────────────────┘
```

Click document → opens modal showing content.
Click skill → shows description/path.
Add button → form to create new.

### 3.2 Navigation Update
Add "Overview" button to `ProjectLayout` header between Backlog and Tasks.
Icon: `FileText` from lucide-react.

### 3.3 Task Properties Sidebar Extensions
In `task-properties-sidebar.tsx`, add these after the existing properties:

**Skill Dropdown:**
- Shows list of project skills
- Select/change skill for this task
- "None" option to clear

**PR Link:**
- Text input or display
- Clickable link when set
- Icon: `GitPullRequest`

**Preview Link:**
- Text input or display  
- Clickable link when set
- Icon: `ExternalLink`

**Context Section:**
- Collapsible section at bottom of task detail
- Title: "Agent Context"
- Shows:
  - "Inherited from project:" list of document names
  - "Task skill:" skill name
  - "Task description:" truncated
- Expandable to show full context payload JSON

### 3.4 Document Viewer Modal
New component: `apps/web/src/components/project-document/document-viewer-modal.tsx`
- Modal/dialog that opens on document click
- Shows document title in header
- Renders content as markdown or monospace text
- Close button

### 3.5 New Fetchers, Hooks, and Mutations

**Fetchers:**
- `apps/web/src/fetchers/skill/get-skills.ts`
- `apps/web/src/fetchers/skill/create-skill.ts`
- `apps/web/src/fetchers/skill/update-skill.ts`
- `apps/web/src/fetchers/skill/delete-skill.ts`
- `apps/web/src/fetchers/project-document/get-documents.ts`
- `apps/web/src/fetchers/project-document/create-document.ts`
- `apps/web/src/fetchers/project-document/update-document.ts`
- `apps/web/src/fetchers/project-document/delete-document.ts`
- `apps/web/src/fetchers/project-document/get-document-content.ts`

**Query Hooks:**
- `apps/web/src/hooks/queries/skill/use-get-skills.ts`
- `apps/web/src/hooks/queries/project-document/use-get-documents.ts`
- `apps/web/src/hooks/queries/project-document/use-get-document-content.ts`

**Mutation Hooks:**
- `apps/web/src/hooks/mutations/skill/use-create-skill.ts`
- `apps/web/src/hooks/mutations/skill/use-update-skill.ts`
- `apps/web/src/hooks/mutations/skill/use-delete-skill.ts`
- `apps/web/src/hooks/mutations/skill/use-update-task-skill.ts`
- `apps/web/src/hooks/mutations/skill/use-update-task-pr-link.ts`
- `apps/web/src/hooks/mutations/skill/use-update-task-preview-link.ts`
- `apps/web/src/hooks/mutations/project-document/use-create-document.ts`
- `apps/web/src/hooks/mutations/project-document/use-update-document.ts`
- `apps/web/src/hooks/mutations/project-document/use-delete-document.ts`

## Implementation Notes

### Follow existing patterns:
- All API routes use `describeRoute` + `validator` with Valibot
- All tables use cuid2 for IDs + timestamps
- Frontend uses TanStack Query + fetchers
- Use existing UI components from `@/components/ui/` (Dialog, Sheet, DropdownMenu, etc.)
- Use Tailwind v4 classes (existing dark theme)

### TypeScript types needed:
- `apps/web/src/types/skill.ts`
- `apps/web/src/types/project-document.ts`

### Drizzle relations to add:
- projectTable → skills (many), documents (many)
- taskTable → skill (one, optional)
- skillTable → project (one), tasks (many)
- projectDocumentTable → project (one)

### Important constraints:
- The Hono client type system is used for e2e type safety. New routes must be included in the AppType union in `apps/api/src/index.ts`
- Always `workspaceAccess` middleware for API routes
- Use `pnpm --filter @kaneo/api db:generate` after schema changes
- Test with `pnpm dev` (both API + web)
