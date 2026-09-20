import express, {type Express, type Request, type Response} from 'express';

// App initialization
const app: Express = express();
const port = 5000;

app.get('/', (req: Request, res: Response)=>{
    res.send('Hello World!')
})

app.listen(port, ()=> {
    console.log(`Server running on port: ${port}`);
})