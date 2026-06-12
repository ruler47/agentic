import test from "node:test";
import assert from "node:assert/strict";

import { buildActionPreparationProfileValues } from "../src/server/modules/runs/action-proposal-profile-values.js";

test("action preparation extracts generic contact values from profile context", () => {
  const values = buildActionPreparationProfileValues({
    groupProfile: {
      id: "group-local",
      instanceId: "instance-local",
      name: "Group",
      description: "Test",
      preferences: {
        contact: {
          email: "family@example.com",
          phone: "+34 600 123 456",
        },
      },
      createdAt: "2026-05-22T10:00:00.000Z",
      updatedAt: "2026-05-22T10:00:00.000Z",
    },
    user: {
      id: "user-admin",
      displayName: "Dmitrii Test",
      role: "admin",
      roles: ["admin"],
      identities: [],
      createdAt: "2026-05-22T10:00:00.000Z",
      updatedAt: "2026-05-22T10:00:00.000Z",
    },
  });

  assert.deepEqual(values, [
    {
      field: "contact_name",
      source: "user_profile",
      value: "Dmitrii Test",
      valuePreview: "Dmitrii Test",
    },
    {
      field: "contact_email",
      source: "group_profile",
      value: "family@example.com",
      valuePreview: "fa***@example.com",
    },
    {
      field: "contact_phone",
      source: "group_profile",
      value: "+34 600 123 456",
      valuePreview: "***3456",
    },
  ]);
});
