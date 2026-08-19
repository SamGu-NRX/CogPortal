---
jupyter:
  jupytext:
    notebook_metadata_filter: nbsphinx,-kernelspec
    text_representation:
      extension: .md
      format_name: markdown
      format_version: '1.3'
      jupytext_version: 1.13.6
  nbsphinx:
    execute: never
---

## Classifying MNIST with Le-Net (MyGrad and MyNN)

<!-- #region -->
In this notebook, we will be training a convolutional neural network (using the Le-Net design described in [this paper](http://yann.lecun.com/exdb/publis/pdf/lecun-98.pdf)) to classify hand-written digits. We will be using the [MNIST dataset](http://yann.lecun.com/exdb/mnist/), which contains labeled images of hand-written digits from 0 to 9. The MNIST dataset has a training set of 60,000 images and a test set of 10,000 images. 


We will be replicating the famous "LeNet" CNN architecture, which was one of the first convolutional neural network designs. We will explain the architecture and operations used in convolutional neural nets throughout this notebook. 

<!-- #endregion -->

```python
import numpy as np
import mygrad as mg
from mygrad import Tensor

from noggin import create_plot
import matplotlib.pyplot as plt

%matplotlib notebook
```


### MNIST Data Loading and preprocessing


First, we will load in our data using handy functions from the `cog_datasets` package. If you haven't already, download the data by calling `download_mnist()`


```python
from cog_datasets import load_mnist, download_mnist
download_mnist()
```


Upon loading these images, we will want to turn these 28x28 images into 32x32 images by using zero-padding. We can simply pad two rows/columns of zeros to all sides of the images.
This is for the sake of making out image size compatible with the convolutions that we want to do. 


```python
# loading in the dataset with train/test data/labels
x_train, y_train, x_test, y_test = load_mnist()

# Running this cell will zero-pad the images
print("x_train shape before:", x_train.shape)

x_train = np.pad(x_train, ((0, 0), (0, 0), (2, 2), (2, 2)), mode="constant")
x_test = np.pad(x_test, ((0, 0), (0, 0), (2, 2), (2, 2)), mode="constant")

print("x_train shape after:", x_train.shape)
```


What is the shape and data-types of these arrays? What is the shape of each individual image? How many color-channels does each number have.


Let's plot some examples from the MNIST dataset below


```python
img_id = 5

fig, ax = plt.subplots()
ax.imshow(x_train[img_id, 0], cmap="gray")
ax.set_title(f"truth: {y_train[img_id]}");
```


The original images stored unsigned 8bit integers for their pixel values. We need to convert these to floating-point values. Let's convert the images (not the labels) 32-bit floats.
You can use the `.astype()` array method to do this, and specify either `np.float32` or `"float32"` in the method call.


```python
# Convert the train and test images to 32-bit float arrays
x_train = x_train.astype(np.float32)  # <COGSTUB>
x_test = x_test.astype(np.float32)  # <COGSTUB>
```


Finally, we need to normalize these images. With cifar-10, we shifted the images by the mean and divided by the standard deviation. Here, let's be a little lazy and simply normalize the images so that their pixel values lie on $[0, 1]$. That is we will simply divide all of the pixels in all of our images by the largest value that a uint8 image can have:  $255$ (which is $2^8 -1$).

```python
# Normalize the training and testing images by dividing their pixels by 255
x_train /= 255.0  # <COGSTUB>
x_test /= 255.0  # <COGSTUB>
```


Complete the following classification accuracy function.

```python
def accuracy(predictions, truth):
    """
    Returns the mean classification accuracy for a batch of predictions.

    Parameters
    ----------
    predictions : Union[numpy.ndarray, mg.Tensor], shape=(M, D)
        The scores for D classes, for a batch of M data points

    truth : numpy.ndarray, shape=(M,)
        The true labels for each datum in the batch: each label is an
        integer in [0, D)

    Returns
    -------
    float
        The fraction of predictions that indicated the correct class.
    """
    # Use your solution from previous notebooks
    return np.mean(np.argmax(predictions, axis=1) == truth)  # <COGLINE>
```

## The "LeNet" Architecture



In the convnet to classify MNIST images, we will construct a CNN with two convolutional layers each structured as: 

```
conv layer --> relu --> pooling layer
```

, followed by two dense layers with a relu between them. Thus our network is:

```
CONV -> RELU -> POOL -> CONV -> RELU -> POOL -> FLATTEN -> DENSE -> RELU -> DENSE -> SOFTMAX
```




### Layer Details

CONV-1: 20 filters, 5x5 filter size, stride-1

POOL-1: 2x2, stride-2

CONV-2: 10 filters, 5x5 filter size, stride-1

POOL-2: 2x2, stride-2

DENSE-3: 20 neurons

DENSE-4: size-???  # hint: what should the dimensionality of our output be?


### Activations

We will be using the "Glorot Uniform" initialization scheme for all of our layers' weights (the biases will be 0, which is the default). If you would like to read more about how Xavier Glorot explains the rationalization behind these weight initializations, look here for [his paper written with Yoshua Bengio](http://proceedings.mlr.press/v9/glorot10a/glorot10a.pdf).

```python
from mynn.layers.conv import conv
from mynn.layers.dense import dense

from mygrad.nnet.initializers import glorot_uniform
from mygrad.nnet.activations import relu
from mygrad.nnet.layers import max_pool
from mygrad.nnet.losses import softmax_crossentropy
```

```python
from functools import partial

# We will use this for all of our intitialization schemes
scaled_glorot = partial(glorot_uniform, gain=np.sqrt(2))
```

```python
# Define your `Model`-MyNN class for the architecture prescribed above.

class Model:
    """A simple convolutional neural network."""

    def __init__(self, num_input_channels, f1, f2, d1, num_classes):
        """
        Parameters
        ----------
        num_input_channels : int
            The number of channels for a input datum

        f1 : int
            The number of filters in conv-layer 1

        f2 : int
            The number of filters in conv-layer 2

        d1 : int
            The number of neurons in dense-layer 1

        num_classes : int
            The number of classes predicted by the model.
        """
        # For all layers, specify weight_initializer=scaled_glorot
        
        # Use `conv` to create a shape-(num_input_channels, f1, 5, 5) conv layer
        self.conv1 = conv(num_input_channels, f1, 5, 5, weight_initializer=scaled_glorot)  # <COGSTUB>
        
        # Use `conv` to create a shape-(f1, f2, 5, 5) conv layer
        self.conv2 = conv(f1, f2, 5, 5, weight_initializer=scaled_glorot)  # <COGSTUB>
        
        # Use `dense` to create a shape-(f2 * 5 * 5, d1) DENSE layer
        self.dense1 = dense(f2 * 5 * 5, d1, weight_initializer=scaled_glorot)  # <COGSTUB>
        
        # Create a shape-(???, ???) dense layer. This is the last layer of your network. 
        #
        # Given the shape of the previous dense layer, what should the first element of this
        # shape be?
        #
        # Given that this is the last layer of this classification network, what should 
        # the last element of this shape be? 
        # (i.e. what must the size of the model's prediction for a single image be?)
        #
        self.dense2 = dense(d1, num_classes, weight_initializer=scaled_glorot)  # <COGSTUB>

    def __call__(self, x):
        """Defines a forward pass of the model.

        Parameters
        ----------
        x : numpy.ndarray, shape=(N, 1, 32, 32)
            The input data, where N is the number of images.

        Returns
        -------
        mygrad.Tensor, shape=(N, num_classes)
            The class scores for each of the N images.
        """

        # Define the "forward pass" for this model based on the architecture detailed above.

        # Convolutions & Pooling
        x = relu(self.conv1(x))  # <COGSTUB> x <- relu(conv1(x))
        x = max_pool(x, (2, 2), 2)  # <COGSTUB> x <- 2x2-maxpool(x)
        x = relu(self.conv2(x))  # <COGSTUB> x <- relu(conv2(x))
        x = max_pool(x, (2, 2), 2)  # <COGSTUB> x <- 2x2-maxpool(x)

        # Use x.reshape(N, -1), where -1 tells numpy to compute the appropriate value for you
        x = x.reshape(x.shape[0], -1)  # <COGSTUB> "flatten" x: shape-(N, F2, H', W') -> (N, -1)

        # Dense layers
        x = relu(self.dense1(x))  # <COGSTUB> x <- relu(dense1(x))
        x = self.dense2(x)  # <COGSTUB> x <- dense2(x)
        return x

    @property
    def parameters(self):
        """A convenience function for getting all the parameters of our model."""
        # Return a list containing the parameters from your conv1, conv2, dense1, and dense2 layers
        return (self.conv1.parameters + self.conv2.parameters + self.dense1.parameters + self.dense2.parameters)  # <COGSTUB>
```

<!-- #region -->
Initialize the SGD-optimizer. We will be adding a new feature to our update method, known as ["momentum"](https://en.wikipedia.org/wiki/Stochastic_gradient_descent#Momentum). The following is a sensible configuration for the optimizer:

```python
SGD(<your model parameters>, learning_rate=0.01, momentum=0.9, weight_decay=5e-04)
```
<!-- #endregion -->

```python
# Import SGD and initialize it as described above
# Also initialize your model
from mynn.optimizers.sgd import SGD

# Initialize your model to have: 
# - 20 filters in the first conv layer
# - 10 filters in the second conv layer
# - ??? input channels (You need to determine this. HINT: how many color channels does one MNIST image have?)
# - ??? number of classes to predict (You need to determine this)
model = Model(f1=20, f2=10, d1=20, num_input_channels=1, num_classes=10)  # <COGSTUB>


optim = SGD(model.parameters, learning_rate=0.01, momentum=0.9, weight_decay=5e-04)  # <COGSTUB> Initialize your optimizer using the instructions above
```

```python
# Running this cell will create a noggin plot

plotter, fig, ax = create_plot(["loss", "accuracy"])
```

Using a batch-size of 100, train your convolutional neural network. Try running through 1 epoch of your data (i.e. enough batches to have processed your entire training data set once) - this may take a while. 

Reference the cifar-10 (solution) notebook for guidance on this.

```python
batch_size = 100  # <COGSTUB> use size 100

for epoch_cnt in range(1):
    idxs = np.arange(len(x_train))  # -> array([0, 1, ..., num_train-1])
    np.random.shuffle(idxs)  # shuffles indices in-place

    for batch_cnt in range(len(x_train) // batch_size):
        batch_indices = idxs[batch_cnt * batch_size : (batch_cnt + 1) * batch_size]
        
        batch = x_train[batch_indices]  # <COGSTUB> get the random batch of our training data
        truth = y_train[batch_indices]  # <COGSTUB> get the true labels for this batch of images
        
        # compute your model's predictions for this batch
        prediction = model(batch)  # <COGSTUB>

        # compute the loss that compares the model's predictions to the true values
        loss = softmax_crossentropy(prediction, truth)  # <COGSTUB>  use softmax_cross_entropy

        # Use mygrad compute the derivatives for your model's parameters, so
        # that we can perform gradient descent.
        loss.backward()  # <COGLINE>

        # execute one step of gradient descent by calling optim.step()
        optim.step()  # <COGLINE>

        # compute the accuracy between the prediction and the truth
        acc = accuracy(prediction, truth)  # <COGSTUB>

        # set the training loss and accuracy
        plotter.set_train_batch(
            {"loss": loss.item(), "accuracy": acc}, batch_size=batch_size
        )

    # Here, we evaluate our model on batches of *testing* data
    # this will show us how good our model does on data that
    # it has never encountered
    # Iterate over batches of *testing* data
    for batch_cnt in range(0, len(x_test) // batch_size):
        idxs = np.arange(len(x_test))
        batch_indices = idxs[batch_cnt * batch_size : (batch_cnt + 1) * batch_size]  # <COGSTUB>  get the batch of our **test** data
        batch = x_test[batch_indices]  # <COGSTUB>  get the batch of our **test** labels

        with mg.no_autodiff:
            # get your model's prediction on the test-batch
            prediction = model(batch)  # <COGSTUB>

            # get the truth values for that test-batch
            truth = y_test[batch_indices]  # <COGSTUB>

            # compute the test accuracy
            acc = accuracy(prediction, truth)  # <COGSTUB>

        # log the test-accuracy in noggin
        plotter.set_test_batch({"accuracy": acc}, batch_size=batch_size)

    plotter.set_train_epoch()
    plotter.set_test_epoch()
plotter.plot()
```


Let's plot our model's predictions on some test images. We will also find specific images where our model gets predictions wrong. 

```python
_, _, img_test, label_test = load_mnist()
labels = load_mnist.labels  # tuple of mnist labels
```

```python
def plot_model_prediction(index):

    true_label_index = label_test[index]
    true_label = load_mnist.labels[true_label_index]

    with mg.no_autodiff:
        # you must pass in a shape-(1, 3072) array
        prediction = model(x_test[index : index + 1])

        # largest score indicates the prediction
        predicted_label_index = np.argmax(prediction.data, axis=1).item()
        predicted_label = labels[predicted_label_index]

    fig, ax = plt.subplots()

    # matplotlib wants shape-(H, W, C) images, with unsigned 8bit pixel values
    img = img_test[index].transpose(1, 2, 0).astype("uint8")

    ax.imshow(img)
    ax.set_title(f"Predicted: {predicted_label}\nTruth: {true_label}")
    return fig, ax
```

```python
index = np.random.randint(0, len(x_test))  # pick a random test-image index

plot_model_prediction(index);
```

```python
# Finding all of the test images where our model is wrong

bad_indices = []

for batch_cnt in range(0, len(x_test) // batch_size):
    idxs = np.arange(len(x_test))
    batch_indices = idxs[batch_cnt * batch_size : (batch_cnt + 1) * batch_size]
    batch = x_test[batch_indices]

    with mg.no_autodiff:
        # get your model's prediction on the test-batch
        prediction = np.argmax(model(batch), axis=1)

        # get the truth values for that test-batch
        truth = y_test[batch_indices]
        (bad,) = np.where(prediction != truth)
        if bad.size:
            bad_indices.extend(batch_indices[bad].tolist())
```

```python
# Running this cell will plot an example of an image where the model
# gets the prediction wrong

# Run this cell multiple times to see different examples

bad_index = bad_indices[np.random.randint(0, len(bad_indices))]  # pick a random test-image index

plot_model_prediction(bad_index);
```

Let's also plot the confusion matrix for this model. This model does a *much* better job than our CIFAR10 model, but it still makes some mistakes. Are there any digits that are particularly tricky?

```python
from sklearn.metrics import ConfusionMatrixDisplay

idxs = np.arange(len(x_test))  # -> array([0, 1, ..., 9999])

predictions = []

for batch_cnt in range(0, len(x_test) // batch_size):

    batch_indices = idxs[batch_cnt*batch_size : (batch_cnt + 1)*batch_size]
    batch = x_test[batch_indices]


    with mg.no_autodiff:
        predictions.append(model(batch))

predictions = np.argmax(np.concatenate(predictions), -1)  # shape-(N,) array of predicted labels
```

```python
ConfusionMatrixDisplay.from_predictions(predictions, y_test);
```
