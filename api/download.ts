import { GET, HEAD, OPTIONS } from "../serverless/routes/download.js";
import { routeMethods, toVercelHandler } from "../serverless/vercel-adapter.js";

export const config = { api: { bodyParser: false } };
export default toVercelHandler(routeMethods({ GET, HEAD, OPTIONS }));
