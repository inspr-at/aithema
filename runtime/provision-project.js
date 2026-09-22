/** Offline operator provisioning: one new mapped project, no creator grant. */
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { createStream } from '../lib/stream.js';
import { validateProjectKinds } from '../lib/validate.js';
import { validateVerifiedActor } from './identity.js';

export function provisionMappedProject({ databaseFile, actor, projectRef, title, projectKinds = ['integration'], apply = false }) {
  validateVerifiedActor(actor);
  validateProjectKinds(projectKinds);
  if (typeof apply !== 'boolean' || !isAbsolute(databaseFile) || !lstatSync(databaseFile).isFile()) {
    throw new Error('Existing regular database and explicit apply mode required.');
  }
  if (actor.can_create_projects !== false || actor.actor_kind !== 'human'
      || actor.roles.length !== 1 || actor.roles[0] !== 'requirements_approver'
      || actor.projects.length !== 1 || actor.projects[0] !== projectRef
      || !/^project:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(projectRef)
      || typeof title !== 'string' || !title.trim() || title.length > 200) {
    throw new Error('Provisioning requires one exact mapped project and a restricted human reviewer.');
  }
  // Open existing schema only. No schema creation/migration or provider is run.
  const db = new DatabaseSync(databaseFile, { readOnly: !apply });
  let transaction = false;
  try {
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN'); transaction = true;
    const existing = db.prepare('SELECT project_ref FROM projects WHERE project_ref = ?').get(projectRef);
    if (existing) throw new Error('Project already exists; provisioning never changes an existing project.');
    db.prepare(`SELECT project_ref, title, project_kinds, stream_json, transcript_json,
      understanding_json, conversation_ref, revision, created_at, updated_at FROM projects LIMIT 0`).all();
    // Confirm the current membership schema without writing any membership.
    db.prepare('SELECT project_ref, subject, grant_kind FROM members LIMIT 0').all();
    // Creation ceilings do not revoke older creator grants. Refuse any prior
    // subject membership in the same snapshot/transaction as the insert.
    if (db.prepare('SELECT 1 FROM members WHERE subject = ? LIMIT 1').get(actor.subject)) {
      throw new Error('Existing subject grants require explicit review before provisioning.');
    }
    if (apply) {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO projects (
        project_ref, title, project_kinds, stream_json, transcript_json,
        understanding_json, conversation_ref, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`).run(
        projectRef, title.trim(), JSON.stringify(projectKinds), JSON.stringify(createStream(projectRef, projectKinds)),
        '[]', `conversation:${randomUUID()}`, now, now,
      );
      db.exec('COMMIT'); transaction = false;
    }
    return { schema: 'inspr.aithema.project-provision.v1', eligible: true, created: apply };
  } finally {
    if (transaction) db.exec('ROLLBACK');
    db.close();
  }
}
