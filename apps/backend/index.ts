import express from 'express';
import {TrainModel, GenerateImage, GenerateImagesFromPack} from 'common/types'
import { prismaClient } from 'db';
import { FalAIModel } from './models/FalAIModel';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from 'dotenv';
import { fal } from '@fal-ai/client';
dotenv.config();

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const s3Client = new S3Client({
  region: 'ap-south-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  }
});


const falAiModel = new FalAIModel();

app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.post('/ai/training', async (req, res) => {
  const parsedBody = TrainModel.safeParse(req.body);
  const images = await req.body.images
  if(!parsedBody.success) {
     res.status(411).json({ error: parsedBody.error });
     return
  }

  const {request_id, response_url} = await falAiModel.trainModel("", parsedBody.data.name)


  const data = await prismaClient.model.create({
    data:{
      name:parsedBody.data.name,
      type:parsedBody.data.type,
      age:parsedBody.data.age,
      ethinicity:parsedBody.data.ethinicity,
      eyeColor:parsedBody.data.eyeColor,
      bald:parsedBody.data.bald,
      userId: "1",
      zipUrl: parsedBody.data.zipUrl,
      falAiRequestId: request_id
    }
  })

  res.json({
    modelId: data.id,
  })

})

app.get('/pre-signed-url', async (req, res) => {
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME!,
    Key: `images/${Date.now()}.jpg`,
  })

  const url = await getSignedUrl(s3Client, command, {
    expiresIn: 3600,
  });

  res.json({
    url,
  })
})

app.post('/ai/generate', async (req, res) => {
  const parsedBody = GenerateImage.safeParse(req.body);
  if(!parsedBody.success) {
     res.status(411).json({ error: parsedBody.error });
     return
  }
  const model = await prismaClient.model.findUnique({
    where: {
      id: parsedBody.data.modelId
    }
  })
  if(!model || !model.tensorPath) {
    res.status(404).json({ error: "Model not found" });
    return
  }

  const {request_id, response_url} = await falAiModel.generateImage(parsedBody.data.prompt, model.tensorPath)
  const images = await prismaClient.outputImages.create({
    data: {
      modelId: parsedBody.data.modelId,
      prompt: parsedBody.data.prompt,
      userId: "1",
      imageUrl: "",
      falAiRequestId: request_id
    }
  })
  res.json({
    imageId: images.id,
  })
})

app.post('/pack/generate', async (req, res) => {
  const parsedBody = GenerateImagesFromPack.safeParse(req.body);
  if(!parsedBody.success) {
     res.status(411).json({ error: parsedBody.error });
     return
  }


  const model = await prismaClient.model.findFirst({
    where: {
      id: parsedBody.data.modelId,
    },
  });

  if (!model) {
    res.status(411).json({
      message: "Model not found",
    });
    return;
  }
  const prompts = await prismaClient.packPrompts.findMany({
    where:{
      packId: parsedBody.data.packId
    }
  })

  let requestIds: { request_id: string }[] = await Promise.all(
    prompts.map((prompt) =>
      falAiModel.generateImage(prompt.prompt, model.tensorPath!)
    )
  );
  const images = await prismaClient.outputImages.createManyAndReturn({
    data: prompts.map((prompt, index) => ({
      modelId: parsedBody.data.modelId,
      prompt: prompt.prompt,
      userId: "1",
      imageUrl: "",
      falAiRequestId: requestIds[index].request_id,
    }))
  })

  res.json({
    images: images.map((image) => ({
      imageId: image.id
  }))
})

})

app.get('/pack/bulk', async (req, res) => {
  const packs = await prismaClient.packs.findMany()
  res.json({packs})
})

app.get('/image/bulk', async (req, res) => {
  const images = req.query.images as string[]
  const limit = 10
  const offset = req.query.offset
  const imagesData = await prismaClient.outputImages.findMany({
    where:{
      id: {
        in: images
      },
      userId: "1",

    },
    take: limit,
    skip: offset ? parseInt(offset as string) : 0
  })
  res.json({images: imagesData})
})

app.post("fal-ai/webhook/train", async (req, res) => {
  console.log("Webhook received:", req.body);
  const request_id = req.body.request_id;

  await prismaClient.model.updateMany({
    where:{
      falAiRequestId: request_id
    },
    data:{
      trainingStatus:"Generated",
      tensorPath:req.body.tensor_path,
    }
  })
  res.json({
    message:"Dekh le ek baari"
  })
  
})

app.post("fal-ai/webhook/image", async (req, res) => {
  console.log("Webhook received:", req.body);
  const request_id = req.body.request_id;

  await prismaClient.outputImages.updateMany({
    where:{
      falAiRequestId: request_id
    },
    data:{
      status:"Generated",
      imageUrl:req.body.image_url,
    }
  })
  res.json({
    message:"Dekh le ek baari"
  })
  
})

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
})