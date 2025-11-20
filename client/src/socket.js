// client/src/socket.js
import { io } from 'socket.io-client';
const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
export const socket = io(API, { autoConnect: true });
export default socket;
