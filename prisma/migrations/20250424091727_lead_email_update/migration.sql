/*
  Warnings:

  - A unique constraint covering the columns `[emailId]` on the table `LeadEmail` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "LeadEmail_emailId_key" ON "LeadEmail"("emailId");
