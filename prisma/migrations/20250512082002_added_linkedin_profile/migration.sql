-- CreateTable
CREATE TABLE "LinkedInPreferences" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL DEFAULT 'single-org',
    "signInMethod" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInPreferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinkedInProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "linkedInId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "jobTitle" TEXT,
    "profileUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LinkedInProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInPreferences_orgId_key" ON "LinkedInPreferences"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInProfile_userId_key" ON "LinkedInProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "LinkedInProfile_linkedInId_key" ON "LinkedInProfile"("linkedInId");

-- AddForeignKey
ALTER TABLE "LinkedInPreferences" ADD CONSTRAINT "LinkedInPreferences_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkedInProfile" ADD CONSTRAINT "LinkedInProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
