/*
  Warnings:

  - A unique constraint covering the columns `[orgId,mailboxEmail,folderId]` on the table `SyncState` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `mailboxEmail` to the `SyncState` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "SyncState_orgId_folderId_key";

-- AlterTable
ALTER TABLE "MicrosoftPreferences" ADD COLUMN     "leadSyncEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "SyncState" ADD COLUMN     "mailboxEmail" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_orgId_mailboxEmail_folderId_key" ON "SyncState"("orgId", "mailboxEmail", "folderId");
