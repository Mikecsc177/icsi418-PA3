const express = require("express");
const cors = require("cors");
require('dotenv').config(); 

const { MongoClient, ObjectId } = require("mongodb");
const client = new MongoClient(process.env.MONGO_URI);

//databases mongo
const db = client.db("pa2");
const users = db.collection("users");
const projects = db.collection("projects");
const memberships = db.collection("projectmemberships");

const app = express();

async function connectDatabase() {
    try {
        await client.connect();
        console.log("Connected to MongoDB");

        //a user can only be in a project once (backup to the check in the route)
        await memberships.createIndex({ project_id: 1, user_id: 1 }, { unique: true });
    } catch (error) {
        console.error("Could not connect to MongoDB");
        console.error(error);
    }
}

connectDatabase();

app.use(express.json());
app.use(cors());

//converts a string into an ObjectId, returns null if it isn't a valid 24 character hex id
function toObjectId(id) {
  if (typeof id === "string" && /^[a-f\d]{24}$/i.test(id)) {
    return new ObjectId(id);
  }
  return null;
}

const VALID_STATUSES = ["Planning", "Active", "Completed"];

app.get("/", (req, res) => {
    res.json({
        message: "Server is running"
    });
});

//sign up
app.post("/signup", async (req, res) => {
 
    //catch for database errors 
  try {
    const { f_name, l_name, username, password } = req.body;

    //ensures required values are provided
    if (!username || !password) {
      return res.status(400).json({ message: "Required information is missing" });
    }

    //checks if the provided username is available
    const existingUser = await users.findOne({ username: username });
    if (existingUser) {
      return res.status(409).json({ message: "Username already exists" });
    }

    //user creation
    await users.insertOne({ 
      f_name: f_name,
      l_name: l_name,
      username: username, 
      password: password 
    });

    //sucessful account creation
    res.status(201).json({ message: "User created successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "server error" });
  }
});

//LOGIN
app.post("/login", async (req, res) => {
  try {
    //user and pass
    const { username, password } = req.body;

    //check for required info 
    if (!username || !password) {
      return res.status(400).json({ message: "Required information is missing" });
    }

    //checks if username is available
    const user = await users.findOne({ username: username });

    //checks for valid credentials
    if (!user || user.password !== password) {
      return res.status(401).json({ message: "Invalid login credentials" });
    }
    res.status(200).json({ message: "Login successful" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//get users
app.get("/users", async (req, res) => {
  try {
    const allUsers = await users
      .find({}, { projection: { password: 0 } })
      .toArray();

    res.status(200).json(allUsers);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//create project
app.post("/projects", async (req, res) => {
  try {
    const { name, description, status, project_lead_id } = req.body;

    //ensures required values are provided
    if (!name || !name.trim() || !description || !description.trim() || !status || !project_lead_id) {
      return res.status(400).json({ message: "Required information is missing" });
    }

    //status must be one of the allowed options
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Status must be Planning, Active, or Completed" });
    }

    //project lead must be a valid id that belongs to an existing user
    const leadId = toObjectId(project_lead_id);
    if (!leadId) {
      return res.status(404).json({ message: "Selected project lead does not exist" });
    }

    const lead = await users.findOne({ _id: leadId });
    if (!lead) {
      return res.status(404).json({ message: "Selected project lead does not exist" });
    }

    //project creation
    const result = await projects.insertOne({
      name: name.trim(),
      description: description.trim(),
      status: status,
      project_lead_id: leadId
    });

    //the project lead is also a member of the project
    try {
      await memberships.insertOne({
        project_id: result.insertedId,
        user_id: leadId
      });
    } catch (membershipError) {
      //undo the project so we don't leave one without its lead as a member
      await projects.deleteOne({ _id: result.insertedId });
      throw membershipError;
    }

    res.status(201).json({ message: "Project created successfully", project_id: result.insertedId });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//get all projects
app.get("/projects", async (req, res) => {
  try {
    const allProjects = await projects.aggregate([
      {
        //look up the user whose _id matches projectleadid
        $lookup: {
          from: "users",
          localField: "project_lead_id",
          foreignField: "_id",
          as: "lead"
        }
      },
      { $unwind: { path: "$lead", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          name: 1,
          description: 1,
          status: 1,
          project_lead_id: 1,
          lead_f_name: "$lead.f_name",
          lead_l_name: "$lead.l_name",
          lead_username: "$lead.username"
        }
      }
    ]).toArray();

    res.status(200).json(allProjects);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//get members of a project
app.get("/projects/:projectId/members", async (req, res) => {
  try {
    //the id in the url is a string, convert it to an ObjectId
    const projectId = toObjectId(req.params.projectId);
    if (!projectId) {
      return res.status(404).json({ message: "Project does not exist" });
    }

    const project = await projects.findOne({ _id: projectId });
    if (!project) {
      return res.status(404).json({ message: "Project does not exist" });
    }

    //find this project's memberships and look up each user so we can show names
    const members = await memberships.aggregate([
      { $match: { project_id: projectId } },
      {
        $lookup: {
          from: "users",
          localField: "user_id",
          foreignField: "_id",
          as: "user"
        }
      },
      { $unwind: "$user" },
      {
        $project: {
          _id: 0,
          membership_id: "$_id",
          user_id: 1,
          f_name: "$user.f_name",
          l_name: "$user.l_name",
          username: "$user.username"
        }
      }
    ]).toArray();

    //mark which member is the project lead
    const result = members.map((member) => ({
      ...member,
      is_lead: member.user_id.equals(project.project_lead_id)
    }));

    res.status(200).json(result);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//add a member to project
app.post("/projects/:projectId/members", async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ message: "Required information is missing" });
    }

    //project must exist
    const projectId = toObjectId(req.params.projectId);
    const project = projectId ? await projects.findOne({ _id: projectId }) : null;
    if (!project) {
      return res.status(404).json({ message: "Project does not exist" });
    }

    //user must exist
    const userId = toObjectId(user_id);
    const user = userId ? await users.findOne({ _id: userId }) : null;
    if (!user) {
      return res.status(404).json({ message: "User does not exist" });
    }

    //user cannot be added to the same project twice
    const existingMembership = await memberships.findOne({ project_id: projectId, user_id: userId });
    if (existingMembership) {
      return res.status(409).json({ message: "User is already a member of this project" });
    }

    await memberships.insertOne({
      project_id: projectId,
      user_id: userId
    });

    res.status(201).json({ message: "Member added successfully" });

  } catch (error) {
    //duplicate key error from the unique index (two requests at the same time)
    if (error.code === 11000) {
      return res.status(409).json({ message: "User is already a member of this project" });
    }
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

app.listen(9000, () => {
    console.log("Server running on port 9000");
}); 
