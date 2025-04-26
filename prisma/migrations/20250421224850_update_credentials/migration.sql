/*
  Warnings:

  - A unique constraint covering the columns `[platform_id,user_id,type]` on the table `PlatformCredentials` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "SyncStatus" ADD VALUE 'DISCONNECTED';

-- AlterTable
ALTER TABLE "PlatformCredentials" ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'MARKETING',
ADD COLUMN     "user_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PlatformCredentials_platform_id_user_id_type_key" ON "PlatformCredentials"("platform_id", "user_id", "type");

-- AddForeignKey
ALTER TABLE "PlatformCredentials" ADD CONSTRAINT "PlatformCredentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
