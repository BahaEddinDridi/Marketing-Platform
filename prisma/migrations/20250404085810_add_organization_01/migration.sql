/*
  Warnings:

  - You are about to drop the column `user_id` on the `SyncState` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[orgId,folderId]` on the table `SyncState` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `orgId` to the `SyncState` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "SyncState_user_id_folderId_key";

-- DropIndex
DROP INDEX "SyncState_user_id_idx";

-- AlterTable
ALTER TABLE "SyncState" DROP COLUMN "user_id",
ADD COLUMN     "orgId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "SyncState_orgId_idx" ON "SyncState"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "SyncState_orgId_folderId_key" ON "SyncState"("orgId", "folderId");
