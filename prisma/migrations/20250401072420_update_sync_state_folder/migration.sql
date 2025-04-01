/*
  Warnings:

  - A unique constraint covering the columns `[user_id,folderId]` on the table `SyncState` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `folderId` to the `SyncState` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "SyncState_user_id_key";

-- DropIndex
DROP INDEX "SyncState_user_id_platform_idx";

-- AlterTable
ALTER TABLE "SyncState" ADD COLUMN     "folderId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "SyncState_user_id_idx" ON "SyncState"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_user_id_folderId_key" ON "SyncState"("user_id", "folderId");
