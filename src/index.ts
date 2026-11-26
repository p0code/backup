import { definePlugin } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";

import { BACKUP_PLUGIN_ID, backupActions } from "./actions.ts";
import { makeBackupService } from "./backup.ts";

export const backupPlugin = definePlugin({
  manifest: {
    id: BACKUP_PLUGIN_ID,
    name: "Backups",
    description:
      "Backs up your chats, attachments, settings and keybindings to Google Drive or S3-compatible storage, encrypted on this machine with your passphrase.",
    version: "0.1.1",
    unofficial: false,
    externalServices: [
      "Google Drive (oauth2.googleapis.com, www.googleapis.com), when chosen",
      "The S3-compatible endpoint you configure, when chosen",
    ],
    capabilities: ["network:outbound", "data:backup"],
    httpRoutes: [],
    apiVersion: 1,
  },
  actions: backupActions,
  start: Effect.gen(function* () {
    const service = yield* makeBackupService();
    return {
      actions: {
        status: () => service.status,
        setSettings: service.setSettings,
        driveSignIn: () => service.driveSignIn,
        driveSignOut: () => service.driveSignOut,
        backupNow: () => service.backupNow,
        list: () => service.list,
        verify: service.verify,
        restore: service.restore,
        cancelRestore: () => service.cancelRestore,
      },
    };
  }),
});

export default backupPlugin;
