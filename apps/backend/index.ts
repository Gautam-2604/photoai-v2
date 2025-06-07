import express from 'express';
import {TrainModel, GenerateImage, GenerateImagesFromPack} from 'common/types'
import { prismaClient } from 'db';
import { FalAIModel } from './models/FalAIModel';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import dotenv from 'dotenv';
import cors from 'cors'

// import paymentRoutes from "./routes/payment.routes";
import { router as webhookRouter } from "./routes/webhook.routes";
import { fal } from '@fal-ai/client';
import { authMiddleware } from './middleware';

const IMAGE_GEN_CREDITS = 1;
const TRAIN_MODEL_CREDITS = 20;


dotenv.config();

const app = express();

app.use(
  cors({
    origin: [ "http://localhost:3000"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());
const PORT = process.env.PORT || 8080;

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

  const credits = await prismaClient.userCredit.findUnique({
    where: {
      userId: req.userId!,
    },
  });

  if ((credits?.amount ?? 0) < IMAGE_GEN_CREDITS) {
    res.status(411).json({
      message: "Not enough credits",
    });
    return;
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

  await prismaClient.userCredit.update({
    where: {
      userId: req.userId!,
    },
    data: {
      amount: { decrement: IMAGE_GEN_CREDITS },
    },
  });
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

  const credits = await prismaClient.userCredit.findUnique({
    where: {
      userId: req.userId!,
    },
  });

  if ((credits?.amount ?? 0) < IMAGE_GEN_CREDITS * prompts.length) {
    res.status(411).json({
      message: "Not enough credits",
    });
    return;
  }

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

  await prismaClient.userCredit.update({
    where: {
      userId: req.userId!,
    },
    data: {
      amount: { decrement: IMAGE_GEN_CREDITS * prompts.length },
    },
  });

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

app.post("/fal-ai/webhook/train", async (req, res) => {
  console.log("====================Received training webhook====================");
  console.log("Received training webhook:", req.body);
  const requestId = req.body.request_id as string;

  // First find the model to get the userId
  const model = await prismaClient.model.findFirst({
    where: {
      falAiRequestId: requestId,
    },
  });

  console.log("Found model:", model);

  if (!model) {
    console.error("No model found for requestId:", requestId);
    res.status(404).json({ message: "Model not found" });
    return;
  }

  // Handle error case
  if (req.body.status === "ERROR") {
    console.error("Training error:", req.body.error);
    await prismaClient.model.updateMany({
      where: {
        falAiRequestId: requestId,
      },
      data: {
        trainingStatus: "Failed",
      },
    });
    
    res.json({
      message: "Error recorded",
    });
    return;
  }

  // Check for both "COMPLETED" and "OK" status
  if (req.body.status === "COMPLETED" || req.body.status === "OK") {
    try {
      // Check if we have payload data directly in the webhook
      let loraUrl;
      if (req.body.payload && req.body.payload.diffusers_lora_file && req.body.payload.diffusers_lora_file.url) {
        // Extract directly from webhook payload
        loraUrl = req.body.payload.diffusers_lora_file.url;
        console.log("Using lora URL from webhook payload:", loraUrl);
      } else {
        // Fetch result from fal.ai if not in payload
        console.log("Fetching result from fal.ai");
        const result = await fal.queue.result("fal-ai/flux-lora-fast-training", {
          requestId,
        });
        console.log("Fal.ai result:", result);
        const resultData = result.data as any;
        loraUrl = resultData.diffusers_lora_file.url;
      }

      // check if the user has enough credits
      const credits = await prismaClient.userCredit.findUnique({
        where: {
          userId: model.userId,
        },
      });

      console.log("User credits:", credits);

      if ((credits?.amount ?? 0) < TRAIN_MODEL_CREDITS) {
        console.error("Not enough credits for user:", model.userId);
        res.status(411).json({
          message: "Not enough credits",
        });
        return;
      }

      console.log("Generating preview image with lora URL:", loraUrl);
      const { imageUrl } = await falAiModel.generateImageSync(loraUrl);

      console.log("Generated preview image:", imageUrl);

      await prismaClient.model.updateMany({
        where: {
          falAiRequestId: requestId,
        },
        data: {
          trainingStatus: "Generated",
          tensorPath: loraUrl,
          thumbnail: imageUrl,
        },
      });

      await prismaClient.userCredit.update({
        where: {
          userId: model.userId,
        },
        data: {
          amount: { decrement: TRAIN_MODEL_CREDITS },
        },
      });

      console.log("Updated model and decremented credits for user:", model.userId);
    } catch (error) {
      console.error("Error processing webhook:", error);
      await prismaClient.model.updateMany({
        where: {
          falAiRequestId: requestId,
        },
        data: {
          trainingStatus: "Failed",
        },
      });
    }
  } else {
    // For any other status, keep it as Pending
    console.log("Updating model status to: Pending");
    await prismaClient.model.updateMany({
      where: {
        falAiRequestId: requestId,
      },
      data: {
        trainingStatus: "Pending",
      },
    });
  }

  res.json({
    message: "Webhook processed successfully",
  });
});

app.post("/fal-ai/webhook/image", async (req, res) => {
  console.log("fal-ai/webhook/image");
  console.log(req.body);
  // update the status of the image in the DB
  const requestId = req.body.request_id;

  if (req.body.status === "ERROR") {
    res.status(411).json({});
    prismaClient.outputImages.updateMany({
      where: {
        falAiRequestId: requestId,
      },
      data: {
        status: "Failed",
        imageUrl: req.body.payload.images[0].url,
      },
    });
    return;
  }

  await prismaClient.outputImages.updateMany({
    where: {
      falAiRequestId: requestId,
    },
    data: {
      status: "Generated",
      imageUrl: req.body.payload.images[0].url,
    },
  });

  res.json({
    message: "Webhook received",
  });
});

app.get("/model/status/:modelId", authMiddleware, async (req, res) => {
  try {
    const modelId = req.params.modelId;

    const model = await prismaClient.model.findUnique({
      where: {
        id: modelId,
        userId: req.userId,
      },
    });

    if (!model) {
      res.status(404).json({
        success: false,
        message: "Model not found",
      });
      return;
    }

    // Return basic model info with status
    res.json({
      success: true,
      model: {
        id: model.id,
        name: model.name,
        status: model.trainingStatus,
        thumbnail: model.thumbnail,
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
      },
    });
    return;
  } catch (error) {
    console.error("Error checking model status:", error);
    res.status(500).json({
      success: false,
      message: "Failed to check model status",
    });
    return;
  }
});

// app.use("/payment", paymentRoutes);
app.use("/api/webhook", webhookRouter);


app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
})