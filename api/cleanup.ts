import { GET } from "../serverless/routes/cleanup.js";
import { routeMethods, toVercelHandler } from "../serverless/vercel-adapter.js";

export const config = { api: { bodyParser: false } };
export default toVercelHandler(routeMethods({ GET }));
