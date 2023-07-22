
const fs = require("fs")
const path = require('path');
const openpgp = require('openpgp')
require('dotenv').config()
const{
  SecretsManagerClient,
  GetSecretValueCommand
}  = require("@aws-sdk/client-secrets-manager")

const { 
S3Client, 
GetObjectCommand,
ListObjectsCommand,
PutObjectCommand,
DeleteObjectCommand
} = require('@aws-sdk/client-s3');

const client = new S3Client({});
const Bucket = process.env.Bucket
const Prefix = process.env.Prefix
const OutputPath = process.env.OutputPath
const PrivatekeyName = process.env.PrivatekeyName
const PassPhraseName = process.env.PassPhraseName
const SecretManagerName = process.env.SecretManagerName
const Region = process.env.Region
const FileExtensionArray = JSON.parse(process.env.FileExtensionArray)

const getObject =  (Bucket, Key) => {
  return new Promise(async (resolve, reject) => {
    const getObjectCommand = new GetObjectCommand({ Bucket, Key })
    try {
      const response = await client.send(getObjectCommand)
      let responseDataChunks = []
      response.Body.once('error', err => reject(err))
      response.Body.on('data', chunk => responseDataChunks.push(chunk))
      response.Body.once('end', () => {
        const concatenatedBuffer = Buffer.concat(responseDataChunks);
        resolve(concatenatedBuffer);
      });
    } catch (err) {
      return reject(err)
    } 
  })
}

const putObject = async(bucketName, objectKey, data) => {
  const putObjectCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: objectKey,
    Body: data,
  });

  try {
    const response = await client.send(putObjectCommand);
    console.log("Object uploaded successfully:", response);
  } catch (error) {
    console.error("Error uploading object:", error);
    throw error;
  }
}

const deleteObject = async(bucketName, objectKey) => {
  try {
    const deleteObjectCommand = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: objectKey,
    });
    const response = await client.send(deleteObjectCommand);
    console.log('File deleted successfully:', response);
  } catch (error) {
    console.error('Error deleting file:', error);
  }
}

const decrypt_pgp = async(file_buffer,passphrase,privatekey) => {
    try {
      const privateKey = await openpgp.decryptKey({
          privateKey: await openpgp.readPrivateKey({ armoredKey: privatekey }),
          passphrase
      });
      const message = await openpgp.readMessage({ binaryMessage: file_buffer });
      const { data: decrypted } = await openpgp.decrypt({ message,decryptionKeys: privateKey });
      return decrypted
    } catch (e) {
        console.log(e.message);
        return e;
    }
};

const getListOfFiles = async (bucketName,prefix)=> {
  const listObjectsCommand = new ListObjectsCommand({
    Bucket: bucketName,
    Prefix:prefix
  });
  try {
    const response = await client.send(listObjectsCommand);
    return response.Contents
  } catch (error) {
    console.error("Error retrieving list of files:", error);
    return error;
  }
}

const connectSecretsManager = ()=>{
  return new SecretsManagerClient({
    region: Region,
  });
}

const getSecretsKey = async()=>{

  let response;
  const client = connectSecretsManager()
  try {
    response = await client.send(
      new GetSecretValueCommand({
        SecretId: SecretManagerName
      })
    );
  } catch (error) {
    throw error;
  }
  return JSON.parse(response.SecretString);

}

const formattedPrivateKey = (privatekey)=>{
  try{
      return privatekey.replace(
        /-----BEGIN PGP PRIVATE KEY BLOCK-----(.*?)-----END PGP PRIVATE KEY BLOCK-----/s,
        (match, captureGroup) => {
          const replacedText = captureGroup.replace(/\s+/g, '\n');
          return `-----BEGIN PGP PRIVATE KEY BLOCK-----
          ${replacedText}-----END PGP PRIVATE KEY BLOCK-----`;
        }
      );
  } catch (error) {
    return error
  }
 
}

exports.handler = async (event) => {
  try{
      let countdecrypted = 0
      let countundecrypted = 0
      const getsecretsKey = await getSecretsKey()
      const passphrase = await getsecretsKey[PassPhraseName]
      const privatekey = await formattedPrivateKey(getsecretsKey[PrivatekeyName])
      const response =  await getListOfFiles( Bucket, Prefix)
      for (const file of response) {
        const file_name = file.Key.split(Prefix)[1]
        const extname = path.extname(file_name).toLowerCase()
        if(FileExtensionArray.includes(extname)){
            const new_file_name = file_name.slice(0,file_name.lastIndexOf("."))
            const data = await getObject(Bucket,file.Key);
            const buffer = await Buffer.from(data);
            const decrypt = await decrypt_pgp(buffer,passphrase,privatekey);
            const buff = Buffer.from(decrypt, "utf-8");
            await putObject(Bucket,OutputPath+new_file_name,buff)
            await deleteObject(Bucket,file.Key)
            countdecrypted++
        }else if(file_name.length > 0){
            countundecrypted++
        }
      }
      if(countdecrypted > 0 && countundecrypted  > 0){
        return `Successfully decrypted ${countdecrypted == 1 ? countdecrypted+" file" : countdecrypted+" files"} and Found ${countundecrypted == 1 ? countundecrypted+" file" : countundecrypted+" files"} that don't have the extension ${FileExtensionArray.join(' , ')}`;
      }else if(countdecrypted > 0){
        return `Successfully decrypted ${countdecrypted == 1 ? countdecrypted+" file":countdecrypted+" files"}`;
      }else if(countundecrypted  > 0){
        return `Found ${countundecrypted == 1 ? countundecrypted+" file":countundecrypted+" files"} that don't have the extension ${FileExtensionArray.join(' , ')}`
      }else{
        return `File not found`
      }
  } catch (error) {
    return error
  }

};
