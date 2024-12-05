# Use Node.js LTS (Long Term Support) as base image
FROM node:lts-alpine

# Set working directory
WORKDIR /app

# Copy package.json and yarn.lock
COPY package.json yarn.lock ./

# Install dependencies
RUN yarn install

# Copy the rest of the application
COPY . .

# Build the application
RUN yarn build

# Install serve globally for production serving
RUN yarn global add serve

# Expose port 3000 (default port for serve)
EXPOSE 3000

# Start the application using serve
CMD ["serve", "-s", "dist"] 