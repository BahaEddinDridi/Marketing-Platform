/*
  Warnings:

  - You are about to drop the column `user_id` on the `Lead` table. All the data in the column will be lost.
  - You are about to drop the column `user_id` on the `MarketingPlatform` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[orgId,email,source_platform]` on the table `Lead` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[orgId,platform_name]` on the table `MarketingPlatform` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `orgId` to the `Lead` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orgId` to the `MarketingPlatform` table without a default value. This is not possible if the table is not empty.
  - Added the required column `orgId` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Lead" DROP CONSTRAINT "Lead_user_id_fkey";

-- DropForeignKey
ALTER TABLE "MarketingPlatform" DROP CONSTRAINT "MarketingPlatform_user_id_fkey";

-- DropIndex
DROP INDEX "Lead_user_id_email_source_platform_key";

-- DropIndex
DROP INDEX "Lead_user_id_idx";

-- DropIndex
DROP INDEX "MarketingPlatform_user_id_platform_name_key";

-- AlterTable
ALTER TABLE "Lead" DROP COLUMN "user_id",
ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "orgId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "MarketingPlatform" DROP COLUMN "user_id",
ADD COLUMN     "orgId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "orgId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tenantId" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lead_orgId_idx" ON "Lead"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_orgId_email_source_platform_key" ON "Lead"("orgId", "email", "source_platform");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingPlatform_orgId_platform_name_key" ON "MarketingPlatform"("orgId", "platform_name");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPlatform" ADD CONSTRAINT "MarketingPlatform_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
