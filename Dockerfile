# Use the official Node.js 18 image (or the appropriate version your application requires)
FROM node:18-alpine

# Create and set the working directory inside the container
WORKDIR /app

# Copy the package.json and package-lock.json files
COPY package*.json ./

# Install project dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Compile TypeScript files
RUN npx tsc

# Expose the port that your application runs on
EXPOSE 3000

# Start the application
CMD ["node", "dist/index.js"]
