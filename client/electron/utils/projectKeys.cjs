'use strict';

const PROJECT_ID_PATTERN = /^\d{8}-[a-z0-9]{6}$/;

function generateProjectId(random = Math.random, now = new Date()) {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += Math.floor(random() * 36).toString(36);
  return `${y}${m}${d}-${suffix}`;
}

function isValidProjectId(value) { return PROJECT_ID_PATTERN.test(String(value || '')); }

function projectTaskKey(projectId, taskKey) {
  if (!projectId) return String(taskKey);
  if (!isValidProjectId(projectId)) throw new Error(`invalid projectId: ${projectId}`);
  return `${projectId}_${taskKey}`;
}

function parseProjectTaskKeyDirName(dirName) {
  const match = /^(\d{8}-[a-z0-9]{6})_(.+)$/.exec(String(dirName || ''));
  return match ? { projectId: match[1], taskKey: match[2] } : null;
}

function taskSlotKey(projectId, type) { return `${projectId || '_global'}:${type}`; }

function buildQueueScopeId(projectId, type, taskId) { return `${projectId || '_global'}:${type}:${taskId}`; }

module.exports = { PROJECT_ID_PATTERN, generateProjectId, isValidProjectId, projectTaskKey, parseProjectTaskKeyDirName, taskSlotKey, buildQueueScopeId };
